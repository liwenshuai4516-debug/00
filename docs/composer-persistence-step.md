# 页面输入持久化组件（手写步骤）

上一轮队列异常协调已由使用者完成，实际语法检查、10项新增及原有队列/读取/输入共37项全部通过。本步骤复用 composer-drafts 和 composer-draft-queue，封装页面输入的读取、保存、发送与异常协调，继续由使用者亲手编写。

最新核对：实际组件已由使用者创建，测试已移到tests/unit，实际组件/renderer语法检查及相关53项通过。页面接线与项目回调、body修正均已完成，实际页面14项模拟检查通过；HEAD加相关页面功能块的副本也通过53项和14项。下一步是 [未确认发送解除接口](composer-send-dismiss-step.md)。以下保留组件完整代码及历史候选说明，不重复创建文件或修复已解决问题。

## 范围与可验证目标

本步新建两个文件：一个页面输入组件和它的专项测试。先完成组件验证，再整体接入现有 renderer.js 的发送、切换与状态展示，避免自动保存提前启用但发送仍走旧流程。

目标：

- 加载时恢复原文，加载期间已有编辑和主动清空优先；同会话刷新不再次读取覆盖。
- 停顿300毫秒保存，持续输入最长1秒发起保存；同会话串行、切换后仍按原编号保存。
- 失败保留输入与原版本，等待显式重试；状态只在保存确认后显示“输入已保存”。
- 发送前先保存，消费确认前新输入只留页面，确认后按新版本保存；成功和主动停止不回填旧原文。
- 缺失确认时通过既有只读接口核对，冲突或仍忙碌时保持暂停并提供重试；未确认快照单独保留。

状态反馈沿用既有深色输入区。已应用 ui-ux-pro-max 的局部 UX 指引：状态显示在输入附近，提供读屏可读提示和明确重试按钮，不能只用颜色表达失败。本步没有新增或替换实际 HTML/CSS，不声称完成页面模拟或真实界面验收。

## 1. 新建页面输入组件

新建 `src/renderer/components/composer-persistence.js`，写入下面完整代码。两个导入指向已有模块，不重复复制它们的实现。

```js
import { createComposerDrafts } from "./composer-drafts.js";
import { createComposerDraftQueue } from "./composer-draft-queue.js";

// 输入框只在这里读写；页面负责把状态显示出来并调用发送接口。
export function createComposerPersistence(input, api, onState) {
  const drafts = createComposerDrafts(input);
  const queue = createComposerDraftQueue((...args) => api.saveComposerDraft(...args));
  const entries = new Map();
  let currentId = null;
  let viewVersion = 0;
  let disposed = false;

  function publish(entry) {
    if (disposed || entry?.sessionId !== currentId) return;
    onState({
      sessionId: currentId,
      message: entry.error ? `输入未保存或未完成核对：${entry.error.message}` : entry.message,
      retryable: Boolean(entry.error),
      canSend: entry.loaded && !entry.preparing && !entry.ticket && !entry.pendingSend && !entry.error,
      pendingSend: entry.pendingSend ? { ...entry.pendingSend } : null,
    });
  }

  function clearTimers(entry) {
    clearTimeout(entry.debounce);
    clearTimeout(entry.deadline);
    entry.debounce = null;
    entry.deadline = null;
  }

  async function save(entry) {
    clearTimers(entry);
    if (!entry.loaded) throw new Error("请先读取当前会话的输入。");
    if (entry.ticket && !entry.confirmed) {
      entry.message = "正在准备发送，新的输入稍后保存。";
      publish(entry);
      return null;
    }
    entry.message = "正在保存输入……";
    publish(entry);
    try {
      const saved = await queue.flush(entry.sessionId);
      entry.error = null;
      entry.message = saved.text === entry.text ? "输入已保存。" : "输入待保存。";
      publish(entry);
      return saved;
    } catch (error) {
      entry.error = error;
      publish(entry);
      throw error;
    }
  }

  function schedule(entry) {
    if (disposed || !entry.loaded || entry.error || (entry.ticket && !entry.confirmed)) return;
    entry.message = "输入待保存。";
    clearTimeout(entry.debounce);
    const run = () => { void save(entry).catch(() => {}); };
    entry.debounce = setTimeout(run, 300);
    // 持续输入也最多等待1秒；同一会话的实际写入由队列串行。
    if (entry.deadline === null) entry.deadline = setTimeout(run, 1000);
    publish(entry);
  }

  function onInput() {
    drafts.recordEdit();
    const entry = entries.get(currentId);
    if (!entry) return;
    entry.local = true;
    entry.text = input.value;
    if (entry.loaded) queue.setText(currentId, input.value);
    schedule(entry);
  }
  input.addEventListener("input", onInput);

  async function switchTo(sessionId) {
    const previous = entries.get(currentId);
    if (previous && input.value !== previous.text) onInput();
    if (previous && currentId !== sessionId) {
      // 切换后的保存仍归原会话；失败保留原记录，回到该会话可重试。
      if (previous.loaded && !previous.error) void save(previous).catch(() => {});
    }
    drafts.switchTo(sessionId);
    currentId = sessionId;
    const view = ++viewVersion;
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = {
        sessionId, text: input.value, local: false, loaded: false, loading: null,
        preparing: false, ticket: null, confirmed: false, pendingSend: null,
        error: null, message: "正在读取输入……", debounce: null, deadline: null,
      };
      entries.set(sessionId, entry);
    }
    if (entry.loaded) {
      input.value = entry.text;
      drafts.recordEdit();
      publish(entry);
      return;
    }
    const restore = drafts.beginRestore();
    if (!restore) entry.local = true;
    publish(entry);
    try {
      if (!entry.loading) {
        entry.loading = (async () => {
          const stored = await api.loadComposerDraft();
          if (stored.sessionId !== sessionId) throw new Error("当前对话已变化，请重新读取输入。");
          // 服务读取与核对不能因页面不回填而跳过；一致后才登记队列。
          const inspected = await api.inspectComposerSend(sessionId);
          if (inspected.sessionId !== sessionId || inspected.revision !== stored.revision || inspected.text !== stored.text) {
            throw new Error("输入读取期间内容已变化，请重新读取并核对。");
          }
          queue.register(stored);
          entry.pendingSend = inspected.pendingSend;
          entry.loaded = true;
          entry.error = null;
          if (entry.local) queue.setText(sessionId, entry.text);
          else entry.text = stored.text;
          return stored;
        })().finally(() => { entry.loading = null; });
      }
      const stored = await entry.loading;
      if (!disposed && currentId === sessionId && view === viewVersion) {
        const restored = drafts.applyRestore(restore, stored);
        if (entry.local) input.value = entry.text;
        else if (!restored) {
          // 兼顾未派发 input 事件的程序赋值，不能让队列仍保留旧正文。
          entry.local = true;
          queue.setText(sessionId, input.value);
        }
        entry.text = input.value;
      }
      entry.message = entry.pendingSend ? "有未确认的发送原文，已保留，请先查看。" : "输入已读取。";
      if (entry.local) schedule(entry);
      publish(entry);
    } catch (error) {
      entry.error = error;
      publish(entry);
      throw error;
    }
  }

  async function prepareSend() {
    const entry = entries.get(currentId);
    if (!entry?.loaded || entry.error || entry.preparing || entry.ticket || entry.pendingSend) {
      throw new Error("输入尚未就绪，或有待确认的发送记录。");
    }
    if (input.value !== entry.text) onInput();
    entry.preparing = true;
    publish(entry);
    try {
      await save(entry);
      if (disposed || currentId !== entry.sessionId) throw new Error("当前页面或会话已变化，请重新发送。");
      const ticket = queue.beginSend(entry.sessionId);
      entry.ticket = ticket;
      entry.confirmed = false;
      entry.local = true;
      entry.text = "";
      input.value = "";
      // 发送清空已经由 beginSend 管理，不再次调用 queue.setText。
      drafts.recordEdit();
      entry.message = "正在准备发送，新的输入稍后保存。";
      return ticket;
    } finally {
      entry.preparing = false;
      publish(entry);
    }
  }

  function confirmConsumed(ticket, ack) {
    const entry = entries.get(ticket?.sessionId);
    if (entry?.ticket !== ticket || !queue.confirmConsumed(ticket, ack)) return false;
    entry.confirmed = true;
    entry.pendingSend = { id: ack.sendId, text: ticket.text, draftRevision: ticket.revision };
    void save(entry).catch(() => {});
    return true;
  }

  async function finishSend(ticket, result) {
    const entry = entries.get(ticket?.sessionId);
    if (entry?.ticket !== ticket) return false;
    if (!["completed", "stopped", "unconfirmed"].includes(result?.outcome)) {
      throw new Error("发送结果尚未确认，请重新核对。");
    }
    confirmConsumed(ticket, result.draft);
    queue.finishSend(ticket);
    entry.ticket = null;
    entry.confirmed = false;
    if (result.outcome !== "unconfirmed" && !result.warning) entry.pendingSend = null;
    // 请求已结束，输入补保存失败只在输入状态区报告，不改写请求结果。
    await save(entry).catch(() => {});
    return true;
  }

  async function recoverSend(ticket) {
    const entry = entries.get(ticket?.sessionId);
    if (entry?.ticket !== ticket) return false;
    try {
      const inspected = await api.inspectComposerSend(ticket.sessionId);
      if (entry.ticket !== ticket) return false;
      let reconciled = queue.reconcileSend(ticket, inspected);
      if (!reconciled && entry.confirmed) {
        reconciled = { ...queue.finishSend(ticket), status: "consumed", pendingSend: inspected.pendingSend };
      }
      if (!reconciled) return false;
      entry.ticket = null;
      entry.confirmed = false;
      entry.pendingSend = reconciled.pendingSend;
      entry.text = reconciled.text;
      entry.error = null;
      if (!disposed && currentId === ticket.sessionId) {
        input.value = entry.text;
        drafts.recordEdit();
      }
      await save(entry).catch(() => {});
      return reconciled;
    } catch (error) {
      entry.error = error;
      publish(entry);
      throw error;
    }
  }

  async function retry() {
    const entry = entries.get(currentId);
    if (!entry) return;
    if (entry.ticket) return recoverSend(entry.ticket);
    if (!entry.loaded) return switchTo(currentId);
    return save(entry);
  }

  function dispose() {
    disposed = true;
    viewVersion += 1;
    input.removeEventListener("input", onInput);
    for (const entry of entries.values()) clearTimers(entry);
  }

  return {
    switchTo, prepareSend, confirmConsumed, finishSend, recoverSend, retry, dispose,
    flush: () => {
      const entry = entries.get(currentId);
      return entry ? save(entry) : Promise.resolve(null);
    },
  };
}
```

组件接受输入框 input、现有 window.agent 接口 api 和 onState 回调。onState 只发布当前会话的状态 DTO：

```js
{
  sessionId,
  message,       // 保存、读取或错误提示，页面用 textContent 展示
  retryable,     // 是否提供重试入口
  canSend,       // 输入就绪状态，页面还须与全页面 busy 状态合并
  pendingSend,   // null 或 { id, text, draftRevision }，用于独立查看原文
}
```

公开方法：

| 方法 | 用途 |
| --- | --- |
| switchTo(sessionId) | 主进程切换成功后绑定输入，按原编号补保存旧会话并恢复目标输入 |
| flush() | 立即补保存当前输入；等待消费确认时返回null，不代表已保存 |
| prepareSend() | 等待保存、固定发送凭证并清空页面输入；页面此后才调用发送接口 |
| confirmConsumed(ticket, ack) | 接受主进程消费确认并安排新输入保存，重复/过期确认返回false |
| finishSend(ticket, result) | 处理 completed/stopped/unconfirmed，补保存失败只报告输入状态 |
| recoverSend(ticket) | 发送结果缺失或异常时读取实际状态并协调；失败保留等待及本地输入 |
| retry() | 对当前会话显式重试读取、保存或待核对发送 |
| dispose() | 移除输入监听和待触发定时器，停止发布页面状态；不是关闭补保存握手 |

onState 中的 canSend 为 false 时，后来的新输入仍可编辑。存在 pendingSend 时保留原文快照并阻止直接再次发送，不自动重发或清理快照。

## 2. 新建专项测试

新建 `tests/unit/composer-persistence.test.js`，完整写入下面代码。现有测试保留原样。使用 Node 内置 EventTarget 模拟输入框与内存接口，不安装浏览器或 DOM 依赖；定时测试使用 Node 内置模拟计时器，不等待真实1秒。

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t, initial = "") {
  const { createComposerPersistence } = await import(
    "../../src/renderer/components/composer-persistence.js"
  );
  class Input extends EventTarget { value = initial; }
  const input = new Input();
  const records = new Map([
    ["a", { sessionId: "a", text: "  A 原文\r\n", revision: 2, pendingSend: null }],
    ["b", { sessionId: "b", text: "B 原文", revision: 5, pendingSend: null }],
  ]);
  let current = "a";
  const calls = [];
  const views = [];
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
      record.text = text;
      record.revision += 1;
      return { sessionId: id, text, revision: record.revision };
    },
  };
  const controller = createComposerPersistence(input, api, (view) => views.push(view));
  t.after(() => controller.dispose());
  return {
    input, records, calls, views, api, controller,
    view: () => views.at(-1),
    select(id) { current = id; },
    edit(text) { input.value = text; input.dispatchEvent(new Event("input")); },
    consume(ticket) {
      const record = records.get(ticket.sessionId);
      assert.equal(record.text, ticket.text);
      assert.equal(record.revision, ticket.revision);
      record.text = "";
      record.revision += 1;
      record.pendingSend = { id: "s1", text: ticket.text, draftRevision: ticket.revision };
      return { sessionId: ticket.sessionId, sendId: "s1", text: "", revision: record.revision };
    },
  };
}

async function settle() {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
}

test("读取完整输入，同会话刷新不重新回填；输入状态只向当前会话发布", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  assert.equal(s.input.value, "  A 原文\r\n");
  assert.equal(s.view().canSend, true);
  s.edit("本地输入");
  await s.controller.switchTo("a");
  assert.equal(s.input.value, "本地输入");
  assert.equal(s.calls.filter(([name]) => name === "load").length, 1);
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "本地输入");
  assert.match(s.view().message, /已保存/);
});

test("加载前编辑后清空及加载期间输入优先，读取和队列登记仍执行", async (t) => {
  for (const text of ["", "加载期间输入\n"]) {
    const s = await setup(t);
    const entered = Promise.withResolvers();
    const released = Promise.withResolvers();
    const load = s.api.loadComposerDraft;
    s.api.loadComposerDraft = async () => {
      const result = await load();
      entered.resolve();
      await released.promise;
      return result;
    };
    if (text === "") { s.edit("预先输入"); s.edit(""); }
    const loading = s.controller.switchTo("a");
    await entered.promise;
    if (text !== "") s.edit(text);
    released.resolve();
    await loading;
    assert.equal(s.input.value, text);
    await s.controller.flush();
    assert.equal(s.records.get("a").text, text);
    assert.equal(s.calls.some(([name]) => name === "inspect"), true);
  }
});

test("A 慢读取跨 B 再回 A 不覆盖新编辑，切换后保存仍归原编号", async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = s.api.loadComposerDraft;
  s.api.loadComposerDraft = async () => {
    const result = await load();
    if (result.sessionId === "a") { entered.resolve(); await released.promise; }
    return result;
  };
  const first = s.controller.switchTo("a");
  await entered.promise;
  s.edit("A 新编辑");
  s.select("b");
  await s.controller.switchTo("b");
  s.edit("B 新编辑");
  s.select("a");
  const again = s.controller.switchTo("a");
  released.resolve();
  await Promise.all([first, again]);
  assert.equal(s.input.value, "A 新编辑");
  await s.controller.flush();
  await settle();
  assert.equal(s.records.get("a").text, "A 新编辑");
  assert.equal(s.records.get("b").text, "B 新编辑");
  assert.equal(s.view().sessionId, "a");
});

test("停顿300毫秒保存，持续输入最长1秒发起保存", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  s.edit("第一版");
  t.mock.timers.tick(299);
  await settle();
  assert.equal(s.calls.filter(([name]) => name === "save").length, 0);
  t.mock.timers.tick(1);
  await settle();
  assert.equal(s.records.get("a").text, "第一版");
  for (let i = 0; i < 5; i += 1) {
    s.edit(`持续输入${i}`);
    t.mock.timers.tick(200);
    await settle();
  }
  assert.equal(s.records.get("a").text, "持续输入4");
});

test("保存失败保留输入，不自动重试，显式重试保存最新编辑", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const save = s.api.saveComposerDraft;
  let failures = 0;
  s.api.saveComposerDraft = async () => { failures += 1; throw new Error("模拟写入失败"); };
  s.edit("失败前输入");
  await assert.rejects(s.controller.flush(), /模拟写入失败/);
  assert.equal(s.view().retryable, true);
  assert.equal(s.view().canSend, false);
  s.edit("失败后继续编辑");
  await settle();
  assert.equal(failures, 1);
  s.api.saveComposerDraft = save;
  await s.controller.retry();
  assert.equal(s.records.get("a").text, "失败后继续编辑");
  assert.equal(s.view().retryable, false);
});

test("发送前先保存原文，等待确认的新输入不写旧版本，确认后补保存", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  s.edit("  待发送原文\r\n ");
  const ticket = await s.controller.prepareSend();
  assert.equal(ticket.text, "  待发送原文\r\n ");
  assert.equal(s.records.get("a").text, ticket.text);
  assert.equal(s.input.value, "");
  s.edit(" \t下一条\n ");
  assert.equal(await s.controller.flush(), null);
  assert.equal(s.records.get("a").text, ticket.text);
  const ack = s.consume(ticket);
  s.controller.confirmConsumed(ticket, ack);
  await settle();
  assert.equal(s.records.get("a").text, " \t下一条\n ");
  s.records.get("a").pendingSend = null;
  await s.controller.finishSend(ticket, { outcome: "completed", draft: ack });
  assert.equal(s.input.value, " \t下一条\n ");
  assert.equal(s.view().canSend, true);
});

test("正常完成和主动停止不恢复原文，未确认或清理警告保留快照", async (t) => {
  for (const outcome of ["completed", "stopped", "unconfirmed", "warning"]) {
    const s = await setup(t);
    await s.controller.switchTo("a");
    const ticket = await s.controller.prepareSend();
    const ack = s.consume(ticket);
    const retained = ["unconfirmed", "warning"].includes(outcome);
    if (!retained) s.records.get("a").pendingSend = null;
    await s.controller.finishSend(ticket, {
      outcome: outcome === "warning" ? "completed" : outcome,
      draft: ack, ...(outcome === "warning" ? { warning: "模拟收尾失败" } : {}),
    });
    assert.equal(s.input.value, "");
    assert.equal(s.view().canSend, !retained);
    assert.equal(Boolean(s.view().pendingSend), retained);
    assert.equal(s.records.get("a").text, "");
  }
});

test("消费前异常核对后恢复原文，但不覆盖等待期间的主动清空", async (t) => {
  for (const clear of [false, true]) {
    const s = await setup(t);
    await s.controller.switchTo("a");
    const ticket = await s.controller.prepareSend();
    if (clear) { s.edit("新输入"); s.edit(""); }
    const result = await s.controller.recoverSend(ticket);
    assert.equal(result.status, "not-consumed");
    assert.equal(s.input.value, clear ? "" : ticket.text);
    assert.equal(s.records.get("a").text, s.input.value);
  }
});

test("核对失败保留等待与输入，显式重试采用消费状态并保存新输入", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  s.consume(ticket);
  s.edit("新输入");
  const inspect = s.api.inspectComposerSend;
  s.api.inspectComposerSend = async () => { throw new Error("请求尚未结束"); };
  await assert.rejects(s.controller.recoverSend(ticket), /尚未结束/);
  assert.equal(s.input.value, "新输入");
  assert.equal(s.view().canSend, false);
  s.api.inspectComposerSend = inspect;
  assert.equal((await s.controller.retry()).status, "consumed");
  assert.equal(s.records.get("a").text, "新输入");
  assert.equal(s.view().pendingSend.text, ticket.text);
});

test("核对期间切换 B，A 的失败恢复不能回填 B", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const inspect = s.api.inspectComposerSend;
  s.api.inspectComposerSend = async (id) => {
    if (id === "a") { entered.resolve(); await released.promise; }
    return inspect(id);
  };
  const recovering = s.controller.recoverSend(ticket);
  await entered.promise;
  s.select("b");
  await s.controller.switchTo("b");
  s.edit("B 新输入");
  released.resolve();
  await recovering;
  assert.equal(s.input.value, "B 新输入");
  s.select("a");
  await s.controller.switchTo("a");
  assert.equal(s.input.value, ticket.text);
});

test("读取中版本变化须重读，一致后才登记队列，不沿用旧版本", async (t) => {
  const s = await setup(t);
  const inspect = s.api.inspectComposerSend;
  let changed = false;
  s.api.inspectComposerSend = async (id) => {
    if (!changed) {
      changed = true;
      Object.assign(s.records.get(id), { text: "外部新版本", revision: 3 });
    }
    return inspect(id);
  };
  await assert.rejects(s.controller.switchTo("a"), /内容已变化/);
  assert.equal(s.view().canSend, false);
  await s.controller.retry();
  assert.equal(s.input.value, "外部新版本");
  s.edit("继续编辑");
  await s.controller.flush();
  assert.equal(s.records.get("a").revision, 4);
});

test("初次读取包含未确认快照时禁止发送，后来的输入仍可保存", async (t) => {
  const s = await setup(t);
  s.records.get("a").pendingSend = { id: "old", text: "旧快照", draftRevision: 0 };
  await s.controller.switchTo("a");
  assert.equal(s.view().canSend, false);
  assert.equal(s.view().pendingSend.text, "旧快照");
  await assert.rejects(s.controller.prepareSend(), /待确认/);
  s.edit("新的未发送输入");
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "新的未发送输入");
  assert.equal(s.records.get("a").pendingSend.text, "旧快照");
});

test("释放组件后移除输入监听和定时保存，不继续发布页面状态", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  t.mock.timers.enable({ apis: ["setTimeout"] });
  s.edit("待保存输入");
  const views = s.views.length;
  s.controller.dispose();
  s.edit("释放后的输入");
  t.mock.timers.tick(2000);
  await settle();
  assert.equal(s.calls.some(([name]) => name === "save"), false);
  assert.equal(s.views.length, views);
});

test("慢保存期间切换会话，准备发送失败但不清空目标输入", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const save = s.api.saveComposerDraft;
  s.api.saveComposerDraft = async (...args) => {
    if (args[0] === "a") { entered.resolve(); await released.promise; }
    return save(...args);
  };
  s.edit("A 准备发送");
  const preparing = s.controller.prepareSend();
  const rejected = assert.rejects(preparing, /会话已变化/);
  await entered.promise;
  s.select("b");
  await s.controller.switchTo("b");
  released.resolve();
  await rejected;
  assert.equal(s.input.value, "B 原文");
  assert.equal(s.records.get("a").text, "A 准备发送");
  assert.equal(s.records.get("a").pendingSend, null);
});

test("发送完成后的输入保存失败只报告输入状态，不恢复原文或改写请求结果", async (t) => {
  const s = await setup(t);
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  const ack = s.consume(ticket);
  s.edit("新的待保存输入");
  s.api.saveComposerDraft = async () => { throw new Error("模拟补保存失败"); };
  s.records.get("a").pendingSend = null;
  assert.equal(await s.controller.finishSend(ticket, { outcome: "completed", draft: ack }), true);
  assert.equal(s.input.value, "新的待保存输入");
  assert.equal(s.view().pendingSend, null);
  assert.equal(s.view().retryable, true);
  assert.match(s.view().message, /补保存失败/);
});

test("读取期间或同会话刷新前的程序赋值仍同步队列，不发送旧正文", async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = s.api.loadComposerDraft;
  s.api.loadComposerDraft = async () => {
    const stored = await load();
    entered.resolve();
    await released.promise;
    return stored;
  };
  const reading = s.controller.switchTo("a");
  await entered.promise;
  s.input.value = "程序设置的新输入";
  released.resolve();
  await reading;
  await s.controller.flush();
  assert.equal(s.records.get("a").text, "程序设置的新输入");
  s.input.value = "刷新前程序设置";
  await s.controller.switchTo("a");
  const ticket = await s.controller.prepareSend();
  assert.equal(ticket.text, "刷新前程序设置");
});
```

## 3. 验证

在项目根目录运行：

```bash
node --check src/renderer/components/composer-persistence.js
node --test \
  tests/unit/composer-persistence.test.js \
  tests/unit/composer-send-reconcile.test.js \
  tests/unit/composer-draft-send-queue.test.js \
  tests/unit/composer-draft-queue.test.js \
  tests/unit/composer-draft-restore.test.js \
  tests/unit/composer-drafts.test.js
```

候选已在临时副本通过53项，其中新增组件测试16项。覆盖读取保护、跨会话保存、保存时机、保存失败与显式重试、原文发送、确认后的新输入、成功/停止/未确认/收尾警告、失败核对与主动清空、跨会话迟到核对、读取版本变化、组件释放、慢保存期间切换、回复结束后补保存失败，以及程序赋值同步。

组件测试使用模拟接口；已有队列回归包含真实临时存储测试。均未读取真实会话或请求模型。候选通过不代表实际应用文件已写入，也不代替页面及真实界面验收。

## 接入页面的下一步约定

组件验证通过后，再根据实际 renderer.js、index.html 和 codex-theme.css 的内容给完整接线边界。整体接入时必须满足：

1. 创建组件应早于首次读取会话，保留加载期间的输入事件。用此组件替换 renderer 直接创建的 composerDrafts，不并行建立两套输入管理器。
2. 主进程确认打开/新建/切换项目或目录后调用 switchTo；输入读取失败不能被描述成主进程会话没有切换。当前会话及列表刷新继续由主进程提供。
3. 发送时先 prepareSend，再把 ticket.text 完整原文及 ticket.sessionId/revision 交给 sendMessage；消费确认监听先于调用发送接口。保留既有流式回复、工具、停止和监听清理逻辑。
4. 发送返回后先标记请求已结束，再 finishSend。列表刷新失败不能触发原文恢复。发送结果缺失时调用 recoverSend；忙碌拒绝时保留状态并提供重试，不能直接恢复旧输入。
5. 输入保存状态单独显示在底部输入附近，使用 role=status 和明确的重试按钮，并加入输入框 aria-describedby。发送按钮禁用条件合并页面busy与最新canSend；保存状态更新不能擅自解除全页面忙碌。
6. 未确认快照以独立区域用textContent展示，保留空白和换行；不将其自动回填普通输入，不写真实剪贴板。后续手动处理出口完成前，可以保留原会话并显式新建其他对话继续工作，不能悄悄删除快照。

本步骤只创建组件和测试，不先把自动保存挂到旧发送逻辑。当前页面仍只保存在内存，完整的重启恢复还需要页面接线、空会话登记/重建和正常关闭补保存；会话置顶归档与上下文常驻入口按总设计后续实施。
