# 下一步：为正常关闭准备全部输入补保存

状态：本指南是待你亲手编写的下一步。助手只在临时副本中验证候选，没有修改实际应用或新增实际测试。未发送侧栏的组件10项、页面19项检查已通过；本步先补保存能力，完成后再接窗口关闭与退出握手。

## 目标、假设与取舍

现有composerPersistence.flush()只处理当前会话。切走时的后台保存可能失败，旧记录仍留在页面内，不能仅保存当前输入就允许窗口关闭。

1. 新增flushAll()，处理本页面已访问且读取成功的全部会话 → 验证：旧会话失败记录也能重试，正在写入时必须等待，最后一次编辑按原编号和版本保存。
2. 未完成读取或发送协调时明确拒绝 → 验证：不能把save()的null返回当作确认，保留输入、未确认发送快照与重试能力。
3. 验证失败与重试边界 → 验证：新增11项专项和现有相关测试共7文件66项通过，不请求模型。

假设未来的关闭流程先冻结编辑和会话操作，并等待发送、输入读取和解除操作结束，再调用flushAll()。这个调用约定很关键：flushAll()负责等待保存，不负责阻止页面产生新编辑或启动其他操作。生成中的关闭后续由窗口握手先停止并等待发送收尾；不要在本步把它接到pagehide。

本步只修改一个组件，新增一个专项测试文件。已落盘的未确认发送快照可以保留并补保存后来输入；仍持有活动发送凭证时则拒绝。没有本地编辑的读取失败记录可以跳过，因为本步没有该会话新的本地输入需要写入；读取失败后编辑过或主动清空过的记录必须先回到该会话重新读取，不能猜测版本。

## 1. 新增flushAll函数

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/components/composer-persistence.js`。

在createComposerPersistence内部，找到现有这一行：

```javascript
  function dispose() {
```

保留原dispose函数，在其正上方插入以下完整函数。不要放到createComposerPersistence外，也不要改动原flush()：

```javascript
  // 关闭准备阶段由页面先冻结编辑和会话操作，再等待这里全部保存确认。
  async function flushAll() {
    if (disposed) throw new Error("输入组件已释放，不能确认关闭前保存。");
    const current = entries.get(currentId);
    if (current && input.value !== current.text) onInput();
    if (!current && input.value !== "") {
      throw new Error("当前输入尚未绑定会话，请先完成初始化后重试。");
    }

    // 先检查全部记录，避免把发送协调中的空返回误当成保存完成。
    for (const entry of entries.values()) {
      if (entry.loading || entry.preparing || entry.ticket || entry.dismissing) {
        throw new Error("请等待输入读取、发送协调或解除操作结束后重试保存。");
      }
      if (!entry.loaded && entry.local) {
        throw new Error("有尚未完成读取的本地输入，请回到对应会话重新读取后再保存。");
      }
    }

    // 复用各会话原有队列，等待在途写入，并显式重试之前失败的保存。
    for (const entry of entries.values()) {
      if (entry.loaded) await save(entry);
    }
  }
```

这里先检查全部记录，再逐个await已有save(entry)。save复用原队列和版本核验，也会等待之前发出的保存；发生失败直接抛出，组件与输入保持可用，下一次显式调用可以重试。成功返回undefined，无需新增结果结构。

## 2. 暴露函数

同一文件底部return对象中，找到：

```javascript
    dismissPendingSend,
    dispose,
```

只将这两行替换为下面三行，后面的原flush实现全部保留：

```javascript
    dismissPendingSend,
    flushAll,
    dispose,
```

## 3. 新建专项测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/composer-close-flush.test.js`，完整内容如下。只复制代码块内部，Markdown围栏不是源码。

测试用内存记录、模拟接口和受控等待验证保存顺序，不读取本地配置/会话或请求模型。Input是测试替身，CRLF断言验证组件原文保存；真实textarea仍遵循浏览器原有换行规则。

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t) {
  const { createComposerPersistence } = await import("../../src/renderer/components/composer-persistence.js");
  class Input extends EventTarget { value = ""; }
  const input = new Input();
  const records = new Map([
    ["a", { sessionId: "a", text: "A 原文", revision: 2, pendingSend: null }],
    ["b", { sessionId: "b", text: "B 原文", revision: 5, pendingSend: null }],
  ]);
  let current = "a";
  const calls = [], views = [];
  const api = {
    async loadComposerDraft() {
      calls.push(["load", current]);
      const { sessionId, text, revision } = records.get(current);
      return { sessionId, text, revision };
    },
    async inspectComposerSend(id) {
      calls.push(["inspect", id]);
      return structuredClone(records.get(id));
    },
    async saveComposerDraft(id, text, revision) {
      calls.push(["save", id, text, revision]);
      const record = records.get(id);
      assert.equal(revision, record.revision);
      Object.assign(record, { text, revision: revision + 1 });
      return { sessionId: id, text, revision: record.revision };
    },
    async dismissComposerSend(id, sendId) {
      calls.push(["dismiss", id, sendId]);
      assert.equal(records.get(id).pendingSend.id, sendId);
      records.get(id).pendingSend = null;
      return { sessionId: id, sendId };
    },
  };
  const controller = createComposerPersistence(input, api, view => views.push(view));
  t.after(() => controller.dispose());
  return {
    input, records, calls, views, api, controller,
    select(id) { current = id; },
    edit(text) { input.value = text; input.dispatchEvent(new Event("input")); },
    consume(ticket) {
      const record = records.get(ticket.sessionId);
      assert.equal(record.revision, ticket.revision);
      record.text = "";
      record.revision += 1;
      record.pendingSend = { id: "send-1", text: ticket.text, draftRevision: ticket.revision };
      return { sessionId: ticket.sessionId, sendId: "send-1", text: "", revision: record.revision };
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("立即补保存完整原文与程序赋值，重复补保存不重复写入", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  s.input.value = "  未派发事件的原文\r\n第二行 \t";
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, s.input.value);
  assert.equal(s.records.get("a").revision, 3);
  await s.controller.flushAll();
  assert.equal(s.calls.filter(([kind]) => kind === "save").length, 1);
});

test("补保存包含离开后保存失败的旧会话，输入和状态仍归当前会话", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const save = s.api.saveComposerDraft;
  let fail = true, attempted = false;
  s.api.saveComposerDraft = async (...args) => {
    if (args[0] === "a" && fail) { attempted = true; throw Error("旧会话保存失败"); }
    return save(...args);
  };
  s.edit("A 待保存");
  s.select("b"); await s.controller.switchTo("b");
  await settle();
  assert.equal(attempted, true);
  assert.equal(s.records.get("a").text, "A 原文");
  s.edit("B 新输入");
  const count = s.views.length;
  fail = false;
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "A 待保存");
  assert.equal(s.records.get("b").text, "B 新输入");
  assert.equal(s.input.value, "B 新输入");
  assert.ok(s.views.slice(count).every(view => view.sessionId === "b"));
});

test("等待已有慢保存和调用前的最新编辑，不能提前报告完成", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const entered = Promise.withResolvers(), gate = Promise.withResolvers();
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async (...args) => {
    entered.resolve(); await gate.promise; return save(...args);
  };
  s.edit("第一版");
  const writing = s.controller.flush();
  await entered.promise;
  s.edit("等待期间的新版本");
  let done = false;
  const closing = s.controller.flushAll().then(() => { done = true; });
  await settle(); assert.equal(done, false);
  gate.resolve(); await Promise.all([writing, closing]);
  assert.equal(s.records.get("a").text, "等待期间的新版本");
  assert.equal(s.records.get("a").revision, 4);
});

test("保存失败抛错但不释放组件，保留原文并允许显式重试", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async () => { throw Error("模拟磁盘失败"); };
  s.edit("必须保留的输入");
  await assert.rejects(s.controller.flushAll(), /模拟磁盘失败/);
  assert.equal(s.input.value, "必须保留的输入");
  assert.equal(s.records.get("a").revision, 2);
  assert.equal(s.views.at(-1).retryable, true);
  s.api.saveComposerDraft = save;
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "必须保留的输入");
  s.edit("失败后仍可编辑"); await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "失败后仍可编辑");
});

test("读取未完成时拒绝补保存，失败读取的本地输入与主动清空也不能跳过", async t => {
  for (const text of ["本地输入", ""]) {
    const s = await setup(t);
    const gate = Promise.withResolvers(), entered = Promise.withResolvers();
    const load = s.api.loadComposerDraft;
    s.api.loadComposerDraft = async () => {
      entered.resolve(); await gate.promise; throw Error("模拟读取失败");
    };
    const reading = s.controller.switchTo("a");
    const rejected = assert.rejects(reading, /模拟读取失败/);
    await entered.promise;
    await assert.rejects(s.controller.flushAll(), /请等待/);
    s.edit("先编辑"); s.edit(text);
    gate.resolve(); await rejected;
    await assert.rejects(s.controller.flushAll(), /尚未完成读取的本地输入/);
    assert.equal(s.input.value, text);
    assert.equal(s.calls.some(([kind]) => kind === "save"), false);
    s.api.loadComposerDraft = load;
    await s.controller.retry(); await s.controller.flushAll();
    assert.equal(s.records.get("a").text, text);
  }
});

test("没有本地编辑的失败读取可跳过，不读取其他会话也不猜测版本", async t => {
  const s = await setup(t);
  s.api.loadComposerDraft = async () => { throw Error("模拟读取失败"); };
  await assert.rejects(s.controller.switchTo("a"), /模拟读取失败/);
  await s.controller.flushAll();
  assert.equal(s.calls.length, 0);
  assert.equal(s.records.get("a").text, "A 原文");
  assert.equal(s.records.get("b").text, "B 原文");
});

test("尚无会话且无输入可完成，有未绑定原文必须拒绝且保留", async t => {
  const s = await setup(t);
  await s.controller.flushAll();
  s.input.value = "  \n";
  await assert.rejects(s.controller.flushAll(), /尚未绑定会话/);
  assert.equal(s.input.value, "  \n");
  assert.equal(s.calls.length, 0);
});

test("已落盘未确认快照不被解除或重发，仍保存后来输入与主动清空", async t => {
  const s = await setup(t);
  const pending = { id: "old", text: "未确认原文", draftRevision: 1 };
  s.records.get("a").pendingSend = structuredClone(pending);
  await s.controller.switchTo("a");
  s.edit("后来输入"); await s.controller.flushAll();
  s.edit(""); await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "");
  assert.deepEqual(s.records.get("a").pendingSend, pending);
  assert.equal(s.calls.some(([kind]) => kind === "dismiss"), false);
  assert.equal(s.views.at(-1).canSend, false);
});

test("准备发送、消费未确认及已确认但未收尾均拒绝补保存，收尾后保存新输入", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const gate = Promise.withResolvers(), entered = Promise.withResolvers();
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async (...args) => {
    entered.resolve(); await gate.promise; return save(...args);
  };
  s.edit("待发送正文");
  const preparing = s.controller.prepareSend();
  await entered.promise;
  await assert.rejects(s.controller.flushAll(), /请等待/);
  gate.resolve(); const ticket = await preparing;
  s.edit("生成时的新输入");
  await assert.rejects(s.controller.flushAll(), /请等待/);
  const ack = s.consume(ticket);
  assert.equal(s.controller.confirmConsumed(ticket, ack), true);
  await assert.rejects(s.controller.flushAll(), /请等待/);
  s.records.get("a").pendingSend = null;
  await s.controller.finishSend(ticket, { outcome: "completed", draft: ack });
  await s.controller.flushAll();
  assert.equal(s.records.get("a").text, "生成时的新输入");
});

test("解除进行中拒绝保存确认，结束后可重试", async t => {
  const s = await setup(t);
  s.records.get("a").pendingSend = { id: "old", text: "旧快照", draftRevision: 1 };
  await s.controller.switchTo("a");
  const gate = Promise.withResolvers();
  const dismiss = s.api.dismissComposerSend;
  s.api.dismissComposerSend = async (...args) => { await gate.promise; return dismiss(...args); };
  const working = s.controller.dismissPendingSend("old");
  await assert.rejects(s.controller.flushAll(), /请等待/);
  gate.resolve(); await working; await s.controller.flushAll();
  assert.equal(s.input.value, "A 原文");
  assert.equal(s.calls.filter(([kind]) => kind === "dismiss").length, 1);
});

test("组件释放后不能报告补保存成功", async t => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  s.edit("尚未保存"); s.controller.dispose();
  await assert.rejects(s.controller.flushAll(), /已释放/);
  assert.equal(s.input.value, "尚未保存");
  assert.equal(s.calls.some(([kind]) => kind === "save"), false);
});
```

## 4. 验证

在 `/Users/liyingjun/Desktop/SW-QA/17-00` 执行：

```bash
node --check src/renderer/components/composer-persistence.js
node --check tests/unit/composer-close-flush.test.js
node --test \
  tests/unit/composer-close-flush.test.js \
  tests/unit/composer-persistence.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-send-dismiss-ui.test.js \
  tests/unit/composer-drafts.test.js
```

预期两个语法检查通过，7个测试文件66项全部通过，无失败、取消或跳过。若新专项提示flushAll不是函数，先核对第1步是否位于组件内部、第2步是否加入return对象，不修改相对导入或放到tests/unit以外。

候选验证：临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-close-flush-chtntkh9`，先仅新增专项测试，旧代码11项均因缺少flushAll失败；加入本指南的函数与导出后，两个语法检查和上述66项全部通过。候选代码与本文代码块一致。这不代表实际文件已由你编写。

## 5. 完成本步后的边界

本步没有新增可点击入口，正常关闭行为还没有改变。验证通过后继续接主进程关闭请求、受限预加载通知和页面确认：页面先禁止编辑与会话操作，等待当前操作/发送收尾，调用flushAll，成功后才允许关闭；失败保留窗口与输入，恢复操作并支持重试。还须一起处理生成中关闭、应用退出与重复关闭请求。

pagehide目前只负责释放组件；浏览器不会等待其异步保存完成，不能在其中await flushAll后就称为正常关闭补保存。完整重启验收须等上述握手完成，再验证关闭前最后输入也能找回；强制结束仍只保证已经确认落盘的内容。
