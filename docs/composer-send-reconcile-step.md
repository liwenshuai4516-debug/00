# 输入队列使用发送核对结果（手写步骤）

本步骤已由使用者完成，实际语法检查及10项新增与既有队列/恢复共37项全部通过。下文代码保留供查阅；下一步见 [页面输入持久化组件](composer-persistence-step.md)。

## 目标与行为

目前 inspectComposerSend 可以读到实际状态，但 register 不会推进已有会话版本，也不能解除发送等待。本步在原队列中增加 reconcileSend(ticket, inspected)，保留既有接口。另记录本地编辑次数，避免“发送后输入、再主动清空”被失败恢复填回旧原文。该问题已先用测试在旧队列复现，再验证候选修正。

reconcileSend 只用于仍等待消费确认的那次发送。ticket 必须使用 beginSend 返回的原对象；inspected 必须来自已完成的 inspectComposerSend 原会话核对，而非普通草稿读取或页面猜测数据。

| 核对结果 | 队列行为 |
| --- | --- |
| 原文和版本均未改变 | 本次尚未消费；只有发送后未编辑且本地为空才恢复原文，保留后来输入与主动清空；返回 status: not-consumed |
| 版本仅前进1、正文为空，快照与本次原文和版本匹配 | 采用消费后的空基线，保留本地新输入，返回 status: consumed 和未确认快照 |
| 版本仅前进1、正文为空，快照为 null | 保留本地新输入，返回 status: advanced；不能据此判断模型请求成功 |
| 其他版本或正文、快照冲突 | 报错且继续暂停，不猜版本或自动覆盖 |
| 凭证过期、已被事件确认 | 返回 false，不用迟到核对改动当前版本 |

核对结果可能带有较早的未确认快照。本次未消费不代表旧快照可以删除，返回的 pendingSend 仍需交给后续手动处理入口。

## 1. 完整替换队列模块

文件：`src/renderer/components/composer-draft-queue.js`。

从第一行注释到最后一个 `}`，完整替换成下面代码。不要追加第二个 createComposerDraftQueue，也不要修改其他渲染组件。

```js
// 管理保存顺序与发送消费版本；会话切换和 DOM 更新由调用方负责。
export function createComposerDraftQueue(saveDraft) {
  const states = new Map();

  function getState(sessionId) {
    const state = states.get(sessionId);
    if (!state) throw new Error("请先读取并登记该会话的输入草稿。");
    return state;
  }

  function snapshot(sessionId, state) {
    return { sessionId, text: state.text, revision: state.revision };
  }

  function register(draft) {
    // 重复或迟到读取不能覆盖本地编辑，也不能回退已确认的版本。
    if (!states.has(draft.sessionId)) {
      states.set(draft.sessionId, {
        text: draft.text,
        savedText: draft.text,
        revision: draft.revision,
        pending: null,
        sending: null,
        editVersion: 0,
      });
    }
    return snapshot(draft.sessionId, getState(draft.sessionId));
  }

  function setText(sessionId, text) {
    const state = getState(sessionId);
    state.text = text;
    // 同样的空串也可能来自主动清空，不能仅靠正文判断是否编辑过。
    state.editVersion += 1;
  }

  function flush(sessionId) {
    const state = getState(sessionId);
    if (state.sending && !state.sending.consumed) {
      return Promise.reject(new Error("请等待输入消费确认后再保存。"));
    }
    if (state.pending) return state.pending;

    // 先登记 Promise，再调用保存函数，保证同一会话只有一个在途保存。
    state.pending = Promise.resolve().then(async () => {
      while (state.text !== state.savedText) {
        const text = state.text;
        const revision = state.revision;
        const result = await saveDraft(sessionId, text, revision);

        if (
          result.sessionId !== sessionId ||
          result.text !== text ||
          result.revision !== revision + 1
        ) {
          throw new Error("输入保存确认与提交内容不匹配。");
        }

        // 只更新这次确认的正文；等待期间的新输入继续留在 state.text。
        state.savedText = text;
        state.revision = result.revision;
      }
      return snapshot(sessionId, state);
    }).finally(() => {
      // 失败向调用方报告，不自动重试或猜测主进程的新版本。
      state.pending = null;
    });
    return state.pending;
  }

  function beginSend(sessionId) {
    const state = getState(sessionId);
    if (state.sending) throw new Error("该会话已有发送尚未结束。");
    if (state.pending || state.text !== state.savedText) {
      throw new Error("请先等待输入保存完成，再发送消息。");
    }
    if (!state.text.trim()) throw new Error("请输入消息内容。");

    // 对象身份区分每次发送；原文和版本固定后，等待确认期间只缓存新输入。
    const ticket = Object.freeze(snapshot(sessionId, state));
    state.sending = { ticket, consumed: false, editVersion: state.editVersion };
    state.text = "";
    return ticket;
  }

  function findSending(ticket) {
    const state = states.get(ticket?.sessionId);
    return state?.sending?.ticket === ticket ? state : null;
  }

  function confirmConsumed(ticket, ack) {
    const state = findSending(ticket);
    if (
      !state || state.sending.consumed ||
      ack?.sessionId !== ticket.sessionId ||
      typeof ack.sendId !== "string" || !ack.sendId ||
      ack.text !== "" || ack.revision !== ticket.revision + 1
    ) {
      return false;
    }

    // 确认只推进已保存基线，不能清空确认等待期间的新输入。
    state.savedText = "";
    state.revision = ack.revision;
    state.sending.consumed = true;
    return true;
  }

  function finishSend(ticket) {
    const state = findSending(ticket);
    if (!state) return false;
    if (!state.sending.consumed) {
      throw new Error("尚未确认输入消费，不能结束本次发送协调。");
    }
    state.sending = null;
    return snapshot(ticket.sessionId, state);
  }

  function rejectBeforeConsume(ticket) {
    const state = findSending(ticket);
    if (!state) return false;
    if (state.sending.consumed) {
      throw new Error("输入已消费，不能按消费前失败恢复。");
    }

    // 仅用于已确定未消费的失败；结果未知时必须保留等待状态。
    if (state.text === "" && state.editVersion === state.sending.editVersion) {
      state.text = ticket.text;
    }
    state.sending = null;
    return snapshot(ticket.sessionId, state);
  }

  function reconcileSend(ticket, inspected) {
    const state = findSending(ticket);
    // 旧凭证或已通过事件确认的发送，不能再用较早的读取结果改写。
    if (!state || state.sending.consumed) return false;

    const pending = inspected?.pendingSend;
    if (
      inspected?.sessionId !== ticket.sessionId ||
      typeof inspected.text !== "string" ||
      !Number.isSafeInteger(inspected.revision) ||
      inspected.revision < 0 ||
      !(pending === null || (
        typeof pending?.id === "string" && pending.id &&
        typeof pending.text === "string" && pending.text.trim() &&
        Number.isSafeInteger(pending.draftRevision) &&
        pending.draftRevision >= 0 && pending.draftRevision < inspected.revision
      ))
    ) {
      throw new Error("发送状态核对结果无效，请保留输入并重新核对。");
    }

    const pendingSend = pending ? { ...pending } : null;
    if (inspected.revision === ticket.revision && inspected.text === ticket.text) {
      // 原文和版本均未改变，才可确定本次发送尚未消费。
      return { ...rejectBeforeConsume(ticket), status: "not-consumed", pendingSend };
    }

    if (
      inspected.revision !== ticket.revision + 1 || inspected.text !== "" ||
      (pending && (pending.draftRevision !== ticket.revision || pending.text !== ticket.text))
    ) {
      // 其他版本或正文变化不自动合并，维持暂停以免覆盖外部状态。
      throw new Error("发送状态与本次原文或版本不匹配，请保留输入并重新核对。");
    }

    state.savedText = "";
    state.revision = inspected.revision;
    state.sending = null;
    // 空快照只证明版本已前进，不能据此宣称模型请求成功。
    return {
      ...snapshot(ticket.sessionId, state),
      status: pending ? "consumed" : "advanced",
      pendingSend,
    };
  }

  return {
    register, setText, flush,
    beginSend, confirmConsumed, finishSend, rejectBeforeConsume, reconcileSend,
  };
}
```

## 2. 调整既有测试中的“没有新编辑”分支

文件：`tests/unit/composer-draft-send-queue.test.js`。

仅在测试“明确消费前失败只在本地为空时恢复原文，保留后续正文和空白”的 for 循环内，找到下面三行：

```js
    const ticket = queue.beginSend("a");
    queue.setText("a", later);
    const restored = queue.rejectBeforeConsume(ticket);
```

替换为下面四行。测试其余断言和其他8项保持原样。

```js
    const ticket = queue.beginSend("a");
    // 空串分支表示发送后没有新编辑；主动清空由新专项测试覆盖。
    if (later !== "") queue.setText("a", later);
    const restored = queue.rejectBeforeConsume(ticket);
```

原因：现在 setText 代表一次本地编辑，即使正文仍是空串也会记录。旧测试的空串分支本意是没有新编辑，因此不再调用 setText；真正的主动清空场景在下面新增测试中验证。不要删除既有9项测试。

## 3. 新建完整专项测试

新建 `tests/unit/composer-send-reconcile.test.js`，写入下面全部代码。

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup() {
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const calls = [];
  const queue = createComposerDraftQueue(async (id, text, revision) => {
    calls.push([id, text, revision]);
    return { sessionId: id, text, revision: revision + 1 };
  });
  queue.register({ sessionId: "a", text: "  原文\r\n", revision: 3 });
  const ticket = queue.beginSend("a");
  return { queue, ticket, calls };
}

function state(ticket, changes = {}) {
  return {
    sessionId: ticket.sessionId, text: ticket.text, revision: ticket.revision,
    pendingSend: null, ...changes,
  };
}

function pending(ticket) {
  return { id: "send-1", text: ticket.text, draftRevision: ticket.revision };
}

test("发送后输入再主动清空，明确消费前失败也不能恢复旧原文", async () => {
  const { queue, ticket, calls } = await setup();
  queue.setText("a", "后来的输入");
  queue.setText("a", "");
  assert.equal(queue.rejectBeforeConsume(ticket).text, "");
  await queue.flush("a");
  assert.deepEqual(calls, [["a", "", 3]]);
});

test("原文与版本未变才恢复未消费输入，同时保留新输入和主动清空", async () => {
  for (const later of [undefined, "新输入", " \t\n", ""]) {
    const { queue, ticket } = await setup();
    if (later !== undefined) queue.setText("a", later);
    const result = queue.reconcileSend(ticket, state(ticket));
    assert.equal(result.status, "not-consumed");
    assert.equal(result.text, later === undefined ? ticket.text : later);
    assert.equal(result.revision, 3);
    assert.equal(result.pendingSend, null);
    assert.equal(queue.confirmConsumed(ticket, {
      sessionId: "a", sendId: "late", text: "", revision: 4,
    }), false);
  }
});

test("匹配消费快照时解除等待，保留新输入并从消费后的版本保存", async () => {
  const { queue, ticket, calls } = await setup();
  queue.setText("a", " \t下一条\r\n ");
  const result = queue.reconcileSend(ticket, state(ticket, {
    text: "", revision: 4, pendingSend: pending(ticket),
  }));
  assert.equal(result.status, "consumed");
  assert.equal(result.text, " \t下一条\r\n ");
  assert.deepEqual(result.pendingSend, pending(ticket));
  assert.deepEqual(await queue.flush("a"), {
    sessionId: "a", text: " \t下一条\r\n ", revision: 5,
  });
  assert.deepEqual(calls, [["a", " \t下一条\r\n ", 4]]);
});

test("版本已前进且快照已清理时不恢复原文，也不声称模型成功", async () => {
  const { queue, ticket, calls } = await setup();
  const result = queue.reconcileSend(ticket, state(ticket, { text: "", revision: 4 }));
  assert.deepEqual(result, {
    sessionId: "a", text: "", revision: 4, status: "advanced", pendingSend: null,
  });
  await queue.flush("a");
  assert.deepEqual(calls, []);
  assert.throws(() => queue.beginSend("a"), /请输入消息/);
});

test("无效核对结果保持暂停，不把缺少快照字段视为 null", async () => {
  const { queue, ticket, calls } = await setup();
  const missing = state(ticket);
  delete missing.pendingSend;
  for (const inspected of [
    null, missing,
    state(ticket, { sessionId: "b" }),
    state(ticket, { text: null }),
    state(ticket, { revision: -1 }),
    state(ticket, { revision: 3.5 }),
    state(ticket, { pendingSend: { id: "", text: "原文", draftRevision: 1 } }),
    state(ticket, { pendingSend: { id: "old", text: "", draftRevision: 1 } }),
    state(ticket, { pendingSend: { id: "old", text: "原文", draftRevision: 3 } }),
  ]) {
    assert.throws(() => queue.reconcileSend(ticket, inspected), /核对结果无效/);
  }
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
});

test("其他版本、正文或不匹配消费快照不自动覆盖，显式核对可重试", async () => {
  const { queue, ticket, calls } = await setup();
  queue.setText("a", "保留本地编辑");
  for (const inspected of [
    state(ticket, { revision: 2 }),
    state(ticket, { text: "被外部修改" }),
    state(ticket, { revision: 5, text: "" }),
    state(ticket, { revision: 4, text: "被外部修改" }),
    state(ticket, { revision: 4, text: "", pendingSend: { ...pending(ticket), text: "其他正文" } }),
    state(ticket, { revision: 4, text: "", pendingSend: { ...pending(ticket), draftRevision: 1 } }),
  ]) {
    assert.throws(() => queue.reconcileSend(ticket, inspected), /不匹配/);
  }
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
  const result = queue.reconcileSend(ticket, state(ticket));
  assert.equal(result.text, "保留本地编辑");
  await queue.flush("a");
  assert.deepEqual(calls, [["a", "保留本地编辑", 3]]);
});

test("相同正文和版本的新发送不会接受旧凭证或复制凭证的迟到核对", async () => {
  const { queue, ticket } = await setup();
  queue.reconcileSend(ticket, state(ticket));
  const second = queue.beginSend("a");
  assert.deepEqual(second, ticket);
  assert.notEqual(second, ticket);
  assert.equal(queue.reconcileSend(ticket, state(ticket)), false);
  assert.equal(queue.reconcileSend({ ...second }, state(second)), false);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.equal(queue.reconcileSend(second, state(second)).status, "not-consumed");
});

test("事件先确认且新输入已保存时，迟到核对不回退版本或原文", async () => {
  const { queue, ticket } = await setup();
  queue.confirmConsumed(ticket, { sessionId: "a", sendId: "s1", text: "", revision: 4 });
  queue.setText("a", "已保存的新输入");
  await queue.flush("a");
  assert.equal(queue.reconcileSend(ticket, state(ticket)), false);
  assert.deepEqual(queue.finishSend(ticket), {
    sessionId: "a", text: "已保存的新输入", revision: 5,
  });
});

test("本次未消费但存在较早的未确认快照时，返回旧快照供手动处理", async () => {
  const { queue, ticket } = await setup();
  const old = { id: "old-send", text: "较早的发送原文", draftRevision: 1 };
  const result = queue.reconcileSend(ticket, state(ticket, { pendingSend: old }));
  assert.equal(result.status, "not-consumed");
  assert.equal(result.text, ticket.text);
  assert.deepEqual(result.pendingSend, old);
  assert.notEqual(result.pendingSend, old);
});

test("真实临时存储核对三种状态后只保存本地新输入，不清理快照", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-reconcile-send-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  for (const mode of ["not-consumed", "consumed", "advanced"]) {
    const store = createSessionStateStore(path.join(root, mode));
    const service = createComposerDraftService({
      getSession: async () => ({ sessionId: "a", sessionManager: { getCwd: () => root } }),
    }, store);
    const queue = createComposerDraftQueue(service.saveDraft);
    queue.register(await service.loadCurrentDraft());
    queue.setText("a", " \t完整原文\r\n ");
    await queue.flush("a");
    const ticket = queue.beginSend("a");
    queue.setText("a", "后来的输入\n");
    if (mode !== "not-consumed") {
      const consumed = await store.consumeDraft("a", root, ticket.text, ticket.revision);
      if (mode === "advanced") await store.completeSend("a", root, consumed.pendingSend.id);
    }
    const inspected = await service.inspectSend("a");
    assert.equal(queue.reconcileSend(ticket, inspected).status, mode);
    await queue.flush("a");
    const saved = await createSessionStateStore(path.join(root, mode)).load("a");
    assert.equal(saved.draft.text, "后来的输入\n");
    assert.equal(saved.draft.revision, mode === "not-consumed" ? 2 : 3);
    assert.deepEqual(saved.pendingSend, inspected.pendingSend);
  }
});
```

## 4. 验证

在项目根目录运行：

```bash
node --check src/renderer/components/composer-draft-queue.js
node --test \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-restore.test.js \
  tests/unit/composer-drafts.test.js
```

候选已通过上述37项，其中新增10项。另与只读核对、输入服务和通信等相关回归联合运行75项通过。测试使用临时文件与模拟会话，不读真实会话或请求模型；项目实际修改后仍须核对。

## 后续页面接入约定

- setText 用于真实编辑，包括输入后清空；beginSend 已把队列输入清空，页面对应清空 DOM 时只通知 composerDrafts.recordEdit，不要再把这次程序清空当作新的用户编辑交给队列。
- 在只读核对接口返回后调用 reconcileSend；接口仍因忙碌而拒绝时，保留等待状态，提供显式重试。
- 返回 false 不能按核对成功处理。如果事件已经先确认，应沿用已确认发送的收尾流程；旧凭证必须忽略。
- 三种成功返回都含当前本地 text/revision 和 pendingSend。结果属于原会话，切换后不能直接填进另一个会话的输入框；真正允许恢复时仍需页面编辑保护。
- consumed 只说明匹配的消费快照存在，advanced 只说明版本前进且快照为空；二者都不表示模型请求成功，不自动重发原文。
- pendingSend 非空时保留快照，后续给查看和手动处理入口；本步骤不删除快照，不能把解除本地队列等待描述成已经处理主进程未确认记录。
- 核对成功后可以明确安排 flush 保存本地新输入；发生版本或正文冲突时继续保留本地内容，不自动重试旧写入。

本步仍是页面发送接线的队列准备。接下来把实际队列与输入读取、自动保存、发送和异常处理接入现有深色页面；当前 renderer 仍未启用输入持久化，不能宣称重启恢复已经完成。空会话重建、未确认快照手动处理及关闭补保存继续按总设计实施。
