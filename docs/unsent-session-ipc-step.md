# 下一步：未发送列表与恢复的IPC和预加载接口

状态：使用者已亲手完成本指南的两个接口文件和9项专项测试。2026-11-02实际工作区及仅HEAD加本次功能块和测试的精确提交副本均通过两个脚本语法检查与下述8文件63项测试。本指南保留实施代码供回顾；下一步见 `docs/unsent-session-list-component-step.md`。

## 目标与边界

本步把已完成的服务开放给页面调用，继续由你亲手编写。只修改两个接口文件，并新增一个专项测试；不调整服务参数、bootstrap组装或页面。

1. 两个IPC处理器共用runIdleOperation → 验证：生成或其他互斥操作期间拒绝，读取/恢复全程阻止新发送和切换，失败后释放。
2. 预加载暴露固定接口 → 验证：读取不传参数，恢复只传原会话编号，不转发页面路径、模型或快照。
3. 贯通临时存储与原输入服务 → 验证：恢复原编号后读取完整输入，迟到保存仍归旧会话，不安全重建失败时保留原会话和快照。

假设后续页面在离开前等待当前输入保存，再恢复并用原bindComposer读取最新输入。本步只补通信层；不会从列表标题或旧快照回填输入。待确认发送仍遵循底层保护。

## 1. 增加两个IPC处理器

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/ipc/agent-ipc.js`。

在registerAgentIpc内部，找到现有这一行：

```javascript
  ipcMain.handle("agent:list-sessions", () => sessionService.listSessions());
```

保留它，在它之后、原agent:open-session处理器之前插入下面完整代码：

```javascript
  // 列表依赖当前真实目录；与恢复共用互斥入口，避免读取时目录被切换。
  ipcMain.handle("agent:list-unsent-sessions", () =>
    runIdleOperation(() => sessionService.listUnsentSessions()),
  );

  // 页面只提交编号，状态快照、目录和模型均由主进程读取。
  ipcMain.handle("agent:restore-unsent-session", (_event, sessionId) =>
    runIdleOperation(() => sessionService.restoreUnsentSession(sessionId)),
  );
```

两个新入口都走原互斥方法，不再增加第二把锁。列表虽然只读，但筛选依赖当前真实工作目录；读取时允许另一条切换会造成目录与结果错配。因此列表也等待生成结束，并阻止期间的新发送、切换、审阅、保存等互斥操作。

agent:save-composer-draft保持独立，操作期间仍可按已登记原编号保存输入；agent:stop仍可调用。不要把它们移入runIdleOperation，也不要修改原listSessions的规则。

## 2. 暴露有限的预加载接口

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/preload/preload.js`。

在exposeInMainWorld的agent对象中，找到现有这一项：

```javascript
  listSessions: () => ipcRenderer.invoke("agent:list-sessions"),
```

保留它，在它之后、原previewSession注释和属性之前插入：

```javascript
  // 当前目录由主进程决定；读取不接受页面路径，恢复只传原会话编号。
  listUnsentSessions: () => ipcRenderer.invoke("agent:list-unsent-sessions"),
  restoreUnsentSession: (sessionId) =>
    ipcRenderer.invoke("agent:restore-unsent-session", sessionId),
```

listUnsentSessions返回原服务的 `{ id, title, workspaceDir, blockedReason }[]`；restoreUnsentSession返回 `{ sessionId, workspaceDir, history }`。预加载原样返回Promise，页面自行处理成功或失败；恢复结果不携带输入正文，正文与版本仍经原loadComposerDraft读取。

保持两处固定通道和参数数量：即使页面多传路径或对象，也不能替代服务内部读取的真实目录、模型和状态。无须新建服务实例或修改bootstrap参数。

## 3. 新建专项测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/unsent-session-ipc.test.js`，完整内容如下。最后一项贯通实际preload、IPC、会话服务、目录绑定和临时存储，仅模拟Agent创建，不请求模型。

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");

function setup() {
  const handlers = new Map(), calls = [];
  let busy = false;
  const sessionService = {
    listUnsentSessions(...args) { calls.push(["list", ...args]); return []; },
    restoreUnsentSession(...args) { calls.push(["restore", ...args]); return { sessionId: args[0] }; },
    newChat() { calls.push(["new"]); },
  };
  const chatService = {
    isBusy: () => busy,
    send() { calls.push(["send"]); },
    stop() { calls.push(["stop"]); },
  };
  registerAgentIpc({
    handle(channel, handler) {
      assert.equal(handlers.has(channel), false, `重复注册：${channel}`);
      handlers.set(channel, handler);
    },
  }, sessionService, chatService, {}, {}, {}, {}, {}, {
    saveDraft(...args) { calls.push(["save", ...args]); return { saved: true }; },
  });
  return {
    handlers, calls, sessionService,
    setBusy(value) { busy = value; },
    invoke: (channel, ...args) => handlers.get(`agent:${channel}`)({}, ...args),
  };
}

function loadPreload(invoke) {
  let agent;
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(name, value) { assert.equal(name, "agent"); agent = value; } },
        ipcRenderer: { invoke },
      };
    },
  });
  return agent;
}

test("生成期间两个入口均拒绝，不进入列表或恢复服务", () => {
  const s = setup();
  s.setBusy(true);
  assert.throws(() => s.invoke("list-unsent-sessions"), /等待当前回复结束/);
  assert.throws(() => s.invoke("restore-unsent-session", "a"), /等待当前回复结束/);
  assert.deepEqual(s.calls, []);
});

test("IPC只转发必要参数，原样返回结果，不把路径、模型和快照交给服务", async () => {
  const s = setup();
  const rows = [{ id: "a", title: "未发送", workspaceDir: "/test", blockedReason: "" }];
  const restored = { sessionId: "a", workspaceDir: "/test", history: [] };
  s.sessionService.listUnsentSessions = (...args) => { assert.deepEqual(args, []); return rows; };
  s.sessionService.restoreUnsentSession = (...args) => { assert.deepEqual(args, ["a"]); return restored; };
  assert.equal(await s.invoke("list-unsent-sessions", "/forged"), rows);
  assert.equal(await s.invoke("restore-unsent-session", "a", "/forged", { model: "forged", draft: "forged" }), restored);
});

for (const method of ["listUnsentSessions", "restoreUnsentSession"]) {
  for (const fails of [false, true]) {
    test(`${method}全程互斥，${fails ? "失败" : "成功"}后释放，输入保存和停止保持独立`, async () => {
      const s = setup();
      const entered = Promise.withResolvers(), finished = Promise.withResolvers();
      s.sessionService[method] = () => { entered.resolve(); return finished.promise; };
      const channel = method === "listUnsentSessions" ? "list-unsent-sessions" : "restore-unsent-session";
      const pending = s.invoke(channel, "a");
      const error = new Error("模拟操作失败");
      const rejected = fails ? assert.rejects(pending, value => value === error) : null;
      await entered.promise;
      try {
        for (const name of [
          "list-unsent-sessions", "restore-unsent-session", "new-chat", "open-session",
          "open-project", "select-workspace", "switch-model", "switch-model-profile",
          "compact-session", "export-conversation", "get-proposal", "apply-proposal",
          "discard-proposal", "list-proposals", "inspect-composer-send", "dismiss-composer-send",
        ]) {
          assert.throws(() => s.invoke(name, "a"), /其他操作完成/);
        }
        assert.throws(() => s.invoke("send-message", "不应发送"), /当前操作结束/);
        assert.deepEqual(await s.invoke("save-composer-draft", "old", "后来输入", 3), { saved: true });
        await s.invoke("stop");
        assert.deepEqual(s.calls, [["save", "old", "后来输入", 3], ["stop"]]);
      } finally {
        if (fails) finished.reject(error); else finished.resolve({ done: true });
        if (rejected) await rejected; else assert.deepEqual(await pending, { done: true });
      }
      await s.invoke("new-chat");
      assert.deepEqual(s.calls.at(-1), ["new"]);
    });
  }
}

test("已有切换操作期间拒绝新入口；同步抛错也释放互斥，可显式重试", async () => {
  const s = setup(), finished = Promise.withResolvers();
  s.sessionService.newChat = () => finished.promise;
  const switching = s.invoke("new-chat");
  try {
    assert.throws(() => s.invoke("list-unsent-sessions"), /其他操作完成/);
    assert.throws(() => s.invoke("restore-unsent-session", "a"), /其他操作完成/);
  } finally {
    finished.resolve(); await switching;
  }
  const failure = new Error("同步读取失败");
  s.sessionService.listUnsentSessions = () => { throw failure; };
  await assert.rejects(s.invoke("list-unsent-sessions"), value => value === failure);
  s.sessionService.listUnsentSessions = () => [];
  assert.deepEqual(await s.invoke("list-unsent-sessions"), []);
  assert.deepEqual(await s.invoke("restore-unsent-session", "a"), { sessionId: "a" });
});

test("预加载限定两个固定通道，丢弃额外参数并原样返回结果或拒绝", async () => {
  const calls = [], rows = [], restored = { sessionId: "a" }, failure = new Error("模拟拒绝");
  const agent = loadPreload((...args) => {
    calls.push(args);
    if (args[1] === "bad") return Promise.reject(failure);
    return Promise.resolve(args[0] === "agent:list-unsent-sessions" ? rows : restored);
  });
  assert.equal(await agent.listUnsentSessions("/forged", { model: "forged" }), rows);
  assert.equal(await agent.restoreUnsentSession("a", "/forged", { draft: "forged" }), restored);
  await assert.rejects(agent.restoreUnsentSession("bad"), value => value === failure);
  assert.deepEqual(calls, [
    ["agent:list-unsent-sessions"],
    ["agent:restore-unsent-session", "a"],
    ["agent:restore-unsent-session", "bad"],
  ]);
});

test("实际preload与IPC贯通临时存储：按原编号恢复，待确认拒绝且保留原会话和输入", async (t) => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "unsent-ipc-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace"), other = path.join(base, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const directory = path.join(base, "state"), store = createSessionStateStore(directory);
  const selection = { provider: "local-test", modelId: "test-model" };
  for (const [id, root, text] of [["target", workspace, " 原输入\r\n"], ["pending", workspace, "发送快照"], ["other", other, "其他目录输入"]]) {
    await store.registerSession(id, root, "empty", selection);
    await store.saveDraft(id, root, text, 0);
  }
  await store.consumeDraft("pending", workspace, "发送快照", 1);
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const created = [];
  // 复用真实目录和绑定检查，只模拟Agent本身，不初始化模型或请求网络。
  const service = createSessionService(path.join(base, "sessions"), async (dir, resume, sessionPath, workspaceDir, recovery) => {
    const result = await createWorkspaceSession({ sessionDir: dir, resume, sessionPath, workspaceDir, recovery });
    const session = {
      sessionId: result.sessionManager.getSessionId(),
      desktopSessionOrigin: result.source,
      sessionManager: result.sessionManager,
      model: { provider: selection.provider, id: selection.modelId },
      get messages() { return this.sessionManager.buildSessionContext().messages; },
      disposed: false,
      dispose() { this.disposed = true; },
    };
    created.push(session); return session;
  }, () => workspace, undefined, store);
  const composer = createComposerDraftService(service, store), handlers = new Map();
  let sends = 0;
  registerAgentIpc({ handle: (channel, handler) => handlers.set(channel, handler) }, service, {
    isBusy: () => false, send() { sends += 1; },
  }, {}, {}, {}, {}, {}, composer);
  // 模拟Electron invoke的Promise与同步错误转拒绝，实际处理器和预加载保持原样。
  const agent = loadPreload((channel, ...args) => Promise.resolve().then(() => handlers.get(channel)({}, ...args)));
  const rows = await agent.listUnsentSessions("/forged");
  assert.deepEqual(rows.map(row => row.id), ["pending", "target"]);
  assert.match(rows[0].blockedReason, /待确认/);
  assert.equal(created.length, 0);
  const old = await agent.loadComposerDraft();
  await agent.saveComposerDraft(old.sessionId, "旧会话输入", 0);
  const previous = await service.getSession();
  assert.deepEqual(await agent.restoreUnsentSession("target", other, { model: "forged" }), {
    sessionId: "target", workspaceDir: workspace, history: [],
  });
  assert.equal(previous.disposed, true);
  assert.deepEqual(await agent.loadComposerDraft(), { sessionId: "target", text: " 原输入\r\n", revision: 1 });
  await agent.saveComposerDraft(old.sessionId, "迟到输入", 1);
  assert.equal((await store.load("target")).draft.text, " 原输入\r\n");
  const current = await service.getSession(), filename = path.join(directory, "pending.json"), before = await fs.readFile(filename, "utf8");
  await assert.rejects(agent.restoreUnsentSession("pending"), /待确认发送/);
  await assert.rejects(agent.restoreUnsentSession("other"), /其他工作目录/);
  await assert.rejects(agent.restoreUnsentSession("../bad"), /无效的会话编号/);
  assert.equal(await service.getSession(), current);
  assert.equal(current.disposed, false);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  assert.equal(sends, 0);
});
```

## 4. 针对性验证

在项目根目录执行：

```bash
node --check src/main/ipc/agent-ipc.js
node --check src/preload/preload.js
node --test \
  tests/unit/unsent-session-ipc.test.js \
  tests/unit/agent-ipc.test.js \
  tests/unit/draft-send-ipc.test.js \
  tests/unit/composer-draft-ipc.test.js \
  tests/unit/composer-send-inspection.test.js \
  tests/unit/composer-send-dismiss.test.js \
  tests/unit/unsent-session-service.test.js \
  tests/unit/session-state-list.test.js
```

临时候选通过两个脚本语法检查及上述8文件63项，其中新增专项9项。候选目录：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-unsent-ipc-advice-xc72zckb`。测试仅使用模拟接口/Agent、临时配置与会话、占位凭据；已有服务专项中的真实SDK检查也禁用网络、不请求模型。不读取真实.env、配置/会话或本地验收文件，不代表实际手写代码或真实重启验收。

本步已完成，页面还没有“未发送”入口。下一小步先编写独立列表组件，再接侧栏与恢复；先等待当前输入保存，恢复成功后绑定返回编号，再await原bindComposer读最新原文/版本与快照。失败保留原消息和输入。

两个新接口共用互斥入口，后续页面不能把listUnsentSessions与listProposals、inspectComposerSend等互斥读取直接放进Promise.all；应按既有输入绑定及草稿读取顺序完成后再读取未发送列表，并保护目录/会话切换后的迟到响应。目录/模型失效时保留输入并允许后续刷新或重试；有待确认发送的条目不得通过新按钮绕过保护。

正常关闭前补保存、无历史待确认发送条目的专门处理入口及完整重启恢复仍待后续步骤。
