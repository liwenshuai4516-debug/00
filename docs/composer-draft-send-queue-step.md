# 输入保存队列：协调发送消费确认（手写步骤）

本步骤接在消费确认通信之后。实际 IPC、preload 和新通信测试已核对，相关 26 项测试通过。下面的队列与测试代码只在临时副本验证，尚未写入项目应用和测试文件。

目标：发送前先保存原文；发送开始后暂停该会话的新保存；消费确认只推进保存基线，不清空后来的输入；迟到确认不能回退版本。沿用原生模块，不改 DOM、不接 renderer、不更改后端协议。

## 1. 完整替换保存队列模块

文件：`src/renderer/components/composer-draft-queue.js`。从第一行注释到最后一个 `}`，用下面完整内容替换；不要保留第二份 `createComposerDraftQueue`。

现有 `register/setText/flush` 保留，新增四个方法：

- `beginSend(sessionId)`：必须先 `await flush(sessionId)`；同步固定原文与版本，返回本次发送凭证，并将队列中的当前输入清空。它不修改输入框。
- `confirmConsumed(ticket, ack)`：凭证必须是 beginSend 返回的原对象；确认匹配时更新版本和已保存基线，保留新输入，返回 true。重复、无效或过期确认返回 false。
- `finishSend(ticket)`：仅在发送调用已结束且已确认消费后，释放本地发送凭证，不恢复原文、不删除主进程快照。
- `rejectBeforeConsume(ticket)`：仅在确定未消费时使用；本地输入为空才恢复原文，保留新正文与空白，返回当前队列快照。已消费时拒绝恢复。

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
      });
    }
    return snapshot(draft.sessionId, getState(draft.sessionId));
  }

  function setText(sessionId, text) {
    getState(sessionId).text = text;
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
    state.sending = { ticket, consumed: false };
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
    if (state.text === "") state.text = ticket.text;
    state.sending = null;
    return snapshot(ticket.sessionId, state);
  }

  return {
    register, setText, flush,
    beginSend, confirmConsumed, finishSend, rejectBeforeConsume,
  };
}
```

## 2. 新建专项测试

新建文件：`tests/unit/composer-draft-send-queue.test.js`。写入下面完整内容。原来的 `composer-draft-queue.test.js`、`composer-draft-restore.test.js` 和 `composer-drafts.test.js` 保持原样。

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

async function setup(save) {
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const calls = [];
  const queue = createComposerDraftQueue(async (id, text, revision) => {
    calls.push([id, text, revision]);
    if (save) return save(id, text, revision);
    return { sessionId: id, text, revision: revision + 1 };
  });
  queue.register({ sessionId: "a", text: "  原文\r\n", revision: 3 });
  return { queue, calls };
}

function ack(ticket, sendId = "send-1") {
  return {
    sessionId: ticket.sessionId,
    sendId,
    text: "",
    revision: ticket.revision + 1,
  };
}

test("发送前必须保存完成，固定完整原文和版本并拒绝重复开始", async () => {
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const { queue } = await setup(async (id, text, revision) => {
    entered.resolve();
    await released.promise;
    return { sessionId: id, text, revision: revision + 1 };
  });

  queue.setText("a", "  修改\r\n\t ");
  assert.throws(() => queue.beginSend("a"), /先等待输入保存/);
  const saving = queue.flush("a");
  try {
    await entered.promise;
    assert.throws(() => queue.beginSend("a"), /先等待输入保存/);
  } finally {
    released.resolve();
    await saving;
  }
  const ticket = queue.beginSend("a");
  assert.deepEqual(ticket, { sessionId: "a", text: "  修改\r\n\t ", revision: 4 });
  assert.equal(Object.isFrozen(ticket), true);
  assert.throws(() => queue.beginSend("a"), /已有发送/);
});

test("消费确认前只缓存新输入，确认后按新版本保存且不清空新输入", async () => {
  const { queue, calls } = await setup();
  const ticket = queue.beginSend("a");
  queue.setText("a", " \t\n ");
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
  assert.equal(queue.confirmConsumed(ticket, ack(ticket)), true);
  assert.deepEqual(await queue.flush("a"), {
    sessionId: "a", text: " \t\n ", revision: 5,
  });
  assert.deepEqual(calls, [["a", " \t\n ", 4]]);
  assert.deepEqual(queue.finishSend(ticket), {
    sessionId: "a", text: " \t\n ", revision: 5,
  });
});

test("没有新输入时确认后的空串不重复写入，也不能再发送空输入", async () => {
  const { queue, calls } = await setup();
  const ticket = queue.beginSend("a");
  queue.confirmConsumed(ticket, ack(ticket));
  assert.deepEqual(await queue.flush("a"), { sessionId: "a", text: "", revision: 4 });
  queue.finishSend(ticket);
  assert.deepEqual(calls, []);
  assert.throws(() => queue.beginSend("a"), /请输入消息/);
});

test("错误归属、版本、正文、编号和复制凭证均不解除等待", async () => {
  const { queue, calls } = await setup();
  const ticket = queue.beginSend("a");
  for (const invalid of [
    null,
    { ...ack(ticket), sessionId: "b" },
    { ...ack(ticket), revision: 9 },
    { ...ack(ticket), text: "错误正文" },
    { ...ack(ticket), sendId: "" },
  ]) {
    assert.equal(queue.confirmConsumed(ticket, invalid), false);
  }
  assert.equal(queue.confirmConsumed({ ...ticket }, ack(ticket)), false);
  assert.throws(() => queue.finishSend(ticket), /尚未确认输入消费/);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  assert.deepEqual(calls, []);
  assert.equal(queue.confirmConsumed(ticket, ack(ticket)), true);
});

test("重复和旧发送确认不能回退版本，迟到结束或拒绝不影响新发送", async () => {
  const { queue } = await setup();
  const first = queue.beginSend("a");
  queue.confirmConsumed(first, ack(first));
  queue.setText("a", first.text);
  await queue.flush("a");
  assert.equal(queue.confirmConsumed(first, ack(first)), false);
  assert.equal(queue.finishSend(first).revision, 5);

  const second = queue.beginSend("a");
  assert.equal(queue.confirmConsumed(first, ack(first)), false);
  assert.equal(queue.confirmConsumed(second, ack(first)), false);
  assert.equal(queue.finishSend(first), false);
  assert.equal(queue.rejectBeforeConsume(first), false);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
  queue.confirmConsumed(second, ack(second, "send-2"));
  assert.equal(queue.finishSend(second).revision, 6);
});

test("明确消费前失败只在本地为空时恢复原文，保留后续正文和空白", async () => {
  for (const later of ["", "后来的输入", " \t\r\n"]) {
    const { queue, calls } = await setup();
    const ticket = queue.beginSend("a");
    queue.setText("a", later);
    const restored = queue.rejectBeforeConsume(ticket);
    assert.equal(restored.text, later === "" ? ticket.text : later);
    assert.equal(restored.revision, ticket.revision);
    assert.equal(queue.confirmConsumed(ticket, ack(ticket)), false);
    await queue.flush("a");
    assert.deepEqual(calls, later === "" ? [] : [["a", later, 3]]);
  }
});

test("结果未返回消费确认时维持等待；返回值可补确认，消费后禁止失败恢复", async () => {
  const { queue } = await setup();
  const ticket = queue.beginSend("a");
  queue.setText("a", "保留新输入");
  assert.throws(() => queue.finishSend(ticket), /尚未确认输入消费/);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);

  // 模拟事件缺失，但 sendMessage 返回值仍带有 draft 确认。
  const result = { outcome: "unconfirmed", draft: ack(ticket), error: "模拟连接中断" };
  assert.equal(queue.confirmConsumed(ticket, result.draft), true);
  assert.throws(() => queue.rejectBeforeConsume(ticket), /输入已消费/);
  assert.equal((await queue.flush("a")).text, "保留新输入");
  assert.equal(queue.finishSend(ticket).text, "保留新输入");
});

test("A 等待消费确认不阻止 B 保存，错会话确认不改变 B", async () => {
  const { queue, calls } = await setup();
  queue.register({ sessionId: "b", text: "B", revision: 7 });
  const ticket = queue.beginSend("a");
  queue.setText("b", "B 的新输入");
  assert.equal(queue.confirmConsumed(ticket, { ...ack(ticket), sessionId: "b" }), false);
  assert.deepEqual(await queue.flush("b"), {
    sessionId: "b", text: "B 的新输入", revision: 8,
  });
  assert.deepEqual(calls, [["b", "B 的新输入", 7]]);
  await assert.rejects(queue.flush("a"), /等待输入消费确认/);
});

test("真实存储消费后保存新输入，不恢复已发送原文或改动待确认快照", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-queue-consume-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(root);
  const original = "  原文\r\n";
  await store.saveDraft("a", root, original, 0);
  // 与临时存储已有版本保持一致，登记真实初值。
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const realQueue = createComposerDraftQueue(async (id, text, revision) => {
    const saved = await store.saveDraft(id, root, text, revision);
    return { sessionId: id, ...saved.draft };
  });
  realQueue.register({ sessionId: "a", text: original, revision: 1 });
  const ticket = realQueue.beginSend("a");
  realQueue.setText("a", "  下一条\n");
  await assert.rejects(realQueue.flush("a"), /等待输入消费确认/);
  const consumed = await store.consumeDraft("a", root, ticket.text, ticket.revision);
  realQueue.confirmConsumed(ticket, {
    sessionId: "a", sendId: consumed.pendingSend.id, ...consumed.draft,
  });
  await realQueue.flush("a");
  realQueue.finishSend(ticket);
  const loaded = await createSessionStateStore(root).load("a");
  assert.equal(loaded.draft.text, "  下一条\n");
  assert.equal(loaded.draft.revision, 3);
  assert.equal(loaded.pendingSend.text, original);
});
```

## 3. 验证

在项目根目录依次运行：

```bash
node --check src/renderer/components/composer-draft-queue.js
node --test \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-restore.test.js \
  tests/unit/composer-drafts.test.js
```

临时副本已通过这 27 项测试，其中新增 9 项；包含真实临时存储的消费与后续输入保存，不读取真实会话或请求模型。另与通信及聊天生命周期四个测试文件联合运行，53 项全部通过。项目实际文件修改后仍须核对，不能直接沿用临时副本结果。

## 4. 页面接入时必须遵守的顺序（后续步骤）

本步完成后先核对模块和测试，随后再接 `renderer.js`。

发送前将输入框的完整原文交给 `setText`，等待 `flush` 成功，随即同步调用 `beginSend`。若等待期间又有编辑，beginSend 会拒绝未保存输入，此时不能发送。只有取得凭证后才清空输入框，并通知既有的 `recordEdit`；后续输入继续通过 setText 留在队列。

消费确认等待期间，flush 会拒绝保存，不能把该拒绝当成保存成功。页面需要等待确认后重新安排保存。A 会话等待不影响 B 会话。消费确认事件和发送返回值中的 `draft` 都可交给同一 `confirmConsumed`；第二次收到相同确认返回 false 属正常情况，不意味着第一次确认失败。

确认只说明输入消费已经落盘，不代表模型请求成功。发送返回 completed、stopped 或 unconfirmed 时，均先用返回的 draft 补确认，再 finishSend；unconfirmed 和 warning 的提示及快照处理仍由页面后续接入。不能在消费确认事件刚到达时就宣称请求结束。

只在明确未调用发送或确定消费前失败时使用 rejectBeforeConsume，并按返回的 text 同步对应会话的页面输入，保持原来的“为空才恢复”规则。普通 IPC 异常、断连、缺失确认不能证明未消费；此时保留等待状态和新输入，不猜版本、不直接恢复或重发。后续接页面前还需完成读取主进程实际状态的协调，以及未确认快照的查看与手动处理出口。

当前 renderer 尚未启用持久化队列与版本发送，页面草稿仍只保存在内存。本步骤不代表已经支持重启恢复；空会话重建、正常关闭补保存、会话置顶归档和上下文常驻入口仍在后续范围。
