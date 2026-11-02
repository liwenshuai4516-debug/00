# 下一步：模型切换与发送结束后的独立登记同步

状态：使用者已亲手完成，实际四个脚本语法检查及23个相关测试文件142项全部通过；仅HEAD加本次功能块的精确提交副本也142项通过。下一小步见 `docs/empty-session-rebuild-step.md`；下文保留本步完整编写指南供对照。

## 本步目标与边界

输入保存时登记已经接通；还缺两个不依赖继续编辑的时点：已保存输入后只切换模型/配置，以及首次发送消息结束后推进history来源。

本步分三段：

1. 会话服务独立同步实际来源和模型，模型切换无论成功或部分更新后报错都等待同步 → 验证：输入版本、原文、快照和组织字段不变；相同选择可在服务层重试。
2. 发送结束后，在清理快照前保存history来源 → 验证：成功、停止和失败均覆盖；本地同步失败不将已完成回复变成请求失败，保留快照。
3. 用户明确解除未确认发送时也先完成来源同步 → 验证：失败不提前清快照，防止失去历史来源证明后冒充空会话。

本步只修改主进程的会话服务、聊天服务、输入服务和bootstrap；不新增模型请求、不改配置默认值、不改变输入内容或发送原文，也不增加IPC/preload参数。继续由你亲手编写。

## 1. 会话服务增加独立同步与切换收尾

文件：`src/main/services/session-service.js`。

在createSessionService参数列表中，原 `saveWorkspaceDir,` 后增加第五参数，完整函数声明为：

```javascript
function createSessionService(
  sessionDir,
  createAgent = createDefaultAgent,
  readWorkspaceDir = () => process.env.AGENT_WORKSPACE_DIR,
  saveWorkspaceDir,
  sessionStateStore,
) {
```

保留上轮的captureRegistration、observeSession和readSessionRegistration。在readSessionRegistration结束后、原“初始化、新建和打开历史共用目录来源”注释之前，插入以下两个完整函数：

```javascript
  async function syncSessionRegistration(sessionId) {
    if (!sessionStateStore) return;
    const selected = readSessionRegistration(sessionId);
    // 没有输入状态时不另建空条目；未来首次保存会读取实际模型。
    if (!selected || !await sessionStateStore.load(sessionId)) return;

    await sessionStateStore.update(sessionId, selected.workspaceDir, (state) => {
      const actual = readSessionRegistration(sessionId);
      if (!actual || actual.workspaceDir !== selected.workspaceDir) {
        throw new Error("会话恢复登记的归属已变化。");
      }
      return {
        ...state,
        registration: {
          source: state.registration?.source === "history" ? "history" : actual.source,
          model: { ...actual.model },
        },
      };
    });
  }

  async function switchAndSync(session, operation) {
    let result;
    let switchError;
    try {
      result = await operation();
    } catch (error) {
      switchError = error;
    }
    try {
      // SDK报错也可能已经更新模型；始终按最终实际选择同步。
      await syncSessionRegistration(session.sessionId);
    } catch (error) {
      const prefix = switchError ? `${switchError.message}；` : "模型可能已切换；";
      throw new Error(`${prefix}恢复登记同步失败：${error.message}`, {
        cause: switchError ?? error,
      });
    }
    if (switchError) throw switchError;
    return result;
  }
```

没有输入状态时不额外创建空白状态文件；首次输入保存仍走已完成的原子保存路径。同步读取发生在同会话更新队列内部，已有history不能降级。

将原switchModel函数整体替换为：

```javascript
  async function switchModel(modelId) {
    if (typeof modelId !== "string" || !modelId.trim()) {
      throw new Error("请选择模型。");
    }

    const session = await getSession(true);
    const current = session.model;

    if (!current) {
      throw new Error("当前会话尚未选择模型。");
    }

    const model = session.modelRuntime.getModel(
      current.provider,
      modelId.trim(),
    );

    if (!model) {
      throw new Error("当前供应商未登记该模型。");
    }

    return switchAndSync(session, async () => {
      // 相同选择仍同步登记，允许登记写入失败后重试，不重复切换模型。
      if (model.id !== current.id) {
        await session.setModel(model, { persist: false });
      }
      return { provider: session.model.provider, modelId: session.model.id };
    });
  }
```

将原switchModelProfile函数整体替换为：

```javascript
  async function switchModelProfile(id) {
    const session = await getSession(true);
    if (!session.desktopModelSettings)
      throw new Error("当前会话未启用多配置。");
    return switchAndSync(session, () =>
      session.desktopModelSettings.switchProfile(session, id),
    );
  }
```

保留listModels、listModelProfiles、配置服务和实际setModel实现。相同选择会再次尝试同步，但不重复调用setModel；SDK失败且同步成功时仍抛回原错误；两者均失败时同时保留原因。

最后在服务返回对象中，将：

```javascript
    readSessionRegistration,
```

替换为：

```javascript
    readSessionRegistration,
    syncSessionRegistration,
```

这是主进程内部接口，不直接暴露给页面。

## 2. 启动时注入同一个状态存储

文件：`src/main/bootstrap.js`。

找到从 `const sessionService = createSessionService(` 开始，到 `const composerDraftService = createComposerDraftService(` 之前的整段；它目前先创建会话服务，再创建sessionStateStore。

将这整段替换为下列代码，保留紧接着的composerDraftService及其两参数调用：

```javascript
// 输入与组织状态共用一个存储实例，独立于 Pi 历史文件。
const sessionStateStore = createSessionStateStore(
  path.join(app.getPath("userData"), "session-state"),
);
const sessionService = createSessionService(
  path.join(projectRoot, "sessions"),
  createConfiguredAgent,
  workspaceSettings.load,
  workspaceSettings.save,
  sessionStateStore,
); // 文件草稿与 Pi 会话保存在当前项目的 sessions 目录内。
```

状态存储必须先创建，再作为会话服务第五参数传入。输入服务第二参数和聊天服务第四参数仍使用同一个sessionStateStore；不要重复创建三份存储实例。

## 3. 聊天结束时同步来源，并保护发送结果

文件：`src/main/services/chat-service.js`。

在send方法内部找到：

```javascript
    let consumed;
    let workspaceDir;
```

替换为：

```javascript
    let consumed;
    let workspaceDir;
    let registrationWarning;
```

找到调用sendMessage的try后面以下完整片段。注意定位注释“主动停止产生的中断”：

```javascript
        } catch (error) {
          // 主动停止产生的中断不作为请求失败展示。
          if (!request.stopped) throw error;
        }
      }

      const result = { stopped: request.stopped };
      if (!consumed) return result;
```

将上述片段整体替换为下列代码，不在其他finally内部追加一套finally：

```javascript
        } catch (error) {
          // 主动停止产生的中断不作为请求失败展示。
          if (!request.stopped) throw error;
        } finally {
          try {
            await sessionService.syncSessionRegistration?.(session.sessionId);
          } catch (error) {
            // 本地登记失败不改变已经完成的请求结果；保留快照供后续核对。
            registrationWarning = `恢复登记同步失败：${error.message}${consumed ? "；发送快照未清理。" : "。"}`;
          }
        }
      }

      const result = {
        stopped: request.stopped,
        ...(registrationWarning ? { warning: registrationWarning } : {}),
      };
      if (!consumed) return result;
```

再找到：

```javascript
      result.draft = consumed;

      try {
```

替换为：

```javascript
      result.draft = consumed;
      if (registrationWarning) return result;

      try {
```

这里的try仍是原来的completeSend调用。同步失败时返回completed/stopped及附加提示，保留待确认快照；不能先清理快照再尝试登记。

最后在外层catch中，找到原完整return：

```javascript
      return {
        stopped: request.stopped,
        outcome: "unconfirmed",
        draft: consumed,
        error: error.message,
      };
```

替换为：

```javascript
      return {
        stopped: request.stopped,
        outcome: "unconfirmed",
        draft: consumed,
        error: error.message,
        ...(registrationWarning ? { warning: registrationWarning } : {}),
      };
```

原activeRequest释放、消费确认、工具事件和completeSend失败提示均保留。同步期间仍保持忙碌，不能提前允许会话切换。

## 4. 手动解除快照前先保存可靠来源

文件：`src/main/services/composer-draft-service.js`。

仅在dismissSend方法内，找到：

```javascript
    const workspaceDir = knownSessions.get(sessionId);
    await sessionStateStore.update(sessionId, workspaceDir, (state) => {
```

替换为：

```javascript
    const workspaceDir = knownSessions.get(sessionId);
    // 历史来源尚未可靠保存时，不能先清除用于核对的发送快照。
    await sessionService.syncSessionRegistration?.(sessionId);
    await sessionStateStore.update(sessionId, workspaceDir, (state) => {
```

保留原来的已登记编号校验、sendId校验及update内部的快照编号匹配。同步失败则继续保留快照，已有页面二次确认及解除重试流程仍可使用。

## 5. 新建专项测试

新建 `tests/unit/registration-sync.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-registration-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(path.join(root, "state"));
  const models = [{ provider: "deepseek", id: "flash" }, { provider: "deepseek", id: "pro" }];
  const session = {
    sessionId: "a", desktopSessionOrigin: "empty", model: models[0], entries: [], messages: [], switches: 0,
    sessionManager: { getCwd: () => root, getEntries: () => session.entries },
    modelRuntime: { getModel: (_provider, id) => models.find(model => model.id === id) },
    async setModel(model) { session.switches += 1; session.model = model; },
    async abort() {}, dispose() {},
  };
  session.desktopModelSettings = {
    async switchProfile(agent, id) {
      agent.model = { provider: `desktop-profile-${id}`, id: "same-model" };
      return { provider: "展示供应商", modelId: "same-model" };
    },
  };
  const sessions = createSessionService("unused", async () => session, () => root, undefined, store);
  const composer = createComposerDraftService(sessions, store);
  await composer.loadCurrentDraft();
  await composer.saveDraft("a", "原文", 0);
  const state = { root, store, session, sessions, composer, calls: 0 };
  state.sender = async () => {
    session.entries.push({ type: "message", message: { role: "user", content: "本地测试消息" } });
  };
  state.chat = createChatService(sessions, async () => async (...args) => {
    state.calls += 1;
    await state.sender(...args);
  }, undefined, store);
  state.send = () => state.chat.send("原文", () => {}, () => {}, () => {}, { sessionId: "a", revision: 1 });
  return state;
}

test("已保存输入后只切换模型或配置，也同步实际选择且保留版本与快照", async (t) => {
  const s = await setup(t);
  await s.store.consumeDraft("a", s.root, "原文", 1);
  await s.store.saveDraft("a", s.root, "后来输入", 2);
  const before = await s.store.load("a");
  await s.sessions.switchModel("pro");
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
  await s.sessions.switchModelProfile("selected");
  const after = await s.store.load("a");
  assert.deepEqual(after.registration.model, { provider: "desktop-profile-selected", modelId: "same-model" });
  assert.deepEqual(after.draft, before.draft);
  assert.deepEqual(after.pendingSend, before.pendingSend);
});

test("SDK部分更新后失败仍同步实际选择，未更新时保留原错误对象", async (t) => {
  const s = await setup(t);
  const error = new Error("SDK更新后失败");
  s.session.setModel = async model => { s.session.model = model; throw error; };
  await assert.rejects(s.sessions.switchModel("pro"), actual => actual === error);
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
  const before = new Error("SDK更新前失败");
  s.session.setModel = async () => { throw before; };
  await assert.rejects(s.sessions.switchModel("flash"), actual => actual === before);
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
});

test("登记发布失败保留原输入，可用相同选择重试且不再次setModel", async (t) => {
  const s = await setup(t);
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("磁盘发布失败"); });
  await assert.rejects(s.sessions.switchModel("pro"), /模型可能已切换.*同步失败.*磁盘发布失败/);
  assert.equal(s.session.model.id, "pro");
  assert.equal((await s.store.load("a")).registration.model.modelId, "flash");
  rename.mock.restore();
  await s.sessions.switchModel("pro");
  assert.equal(s.session.switches, 1);
  assert.equal((await s.store.load("a")).registration.model.modelId, "pro");
  assert.deepEqual((await s.store.load("a")).draft, { text: "原文", revision: 1 });
});

test("切换与登记同时失败时提示保留两个原因", async (t) => {
  const s = await setup(t);
  s.session.setModel = async model => { s.session.model = model; throw new Error("SDK错误"); };
  t.mock.method(fs, "rename", async () => { throw new Error("存储错误"); });
  await assert.rejects(s.sessions.switchModel("pro"), /SDK错误.*同步失败.*存储错误/);
});

test("没有输入记录的同步不新建空状态条目", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-sync-empty-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  const store = createSessionStateStore(directory);
  const session = {
    sessionId: "empty", desktopSessionOrigin: "empty", model: { provider: "p", id: "m" },
    sessionManager: { getCwd: () => root, getEntries: () => [] },
  };
  const service = createSessionService("unused", async () => session, () => root, undefined, store);
  await service.getSession();
  await service.syncSessionRegistration("empty");
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("首次发送先推进history再清快照，即使没有后续输入也保存来源", async (t) => {
  const s = await setup(t);
  const complete = s.store.completeSend;
  t.mock.method(s.store, "completeSend", async (...args) => {
    assert.equal((await s.store.load("a")).registration.source, "history");
    return complete(...args);
  });
  const result = await s.send();
  assert.equal(result.outcome, "completed");
  assert.equal(result.warning, undefined);
  const state = await s.store.load("a");
  assert.equal(state.registration.source, "history");
  assert.equal(state.pendingSend, null);
});

test("首次发送失败保留未确认快照，同时登记已存在的用户消息", async (t) => {
  const s = await setup(t);
  const original = s.sender;
  s.sender = async () => { await original(); throw new Error("连接中断"); };
  const result = await s.send();
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /连接中断/);
  const state = await s.store.load("a");
  assert.equal(state.registration.source, "history");
  assert.equal(state.pendingSend.id, result.draft.sendId);
  assert.equal(s.calls, 1);
});

test("生成期间停止保留新输入并同步history，初始化期间停止仍为empty", async (t) => {
  const s = await setup(t);
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const original = s.sender;
  s.sender = async () => { await original(); entered.resolve(); await finished.promise; };
  s.session.abort = async () => finished.resolve();
  const pending = s.send();
  await entered.promise;
  await s.store.saveDraft("a", s.root, "停止前的新输入", 2);
  await s.chat.stop();
  assert.equal((await pending).outcome, "stopped");
  const saved = await s.store.load("a");
  assert.equal(saved.registration.source, "history");
  assert.equal(saved.pendingSend, null);
  assert.equal(saved.draft.text, "停止前的新输入");

  const other = await setup(t);
  const loading = Promise.withResolvers();
  const ready = Promise.withResolvers();
  other.sessions.getSession = () => { loading.resolve(); return ready.promise; };
  const stopped = other.send();
  await loading.promise;
  await other.chat.stop();
  ready.resolve(other.session);
  assert.equal((await stopped).outcome, "stopped");
  assert.equal(other.calls, 0);
  assert.equal((await other.store.load("a")).registration.source, "empty");
});

test("回复完成但同步失败保持completed，保留快照且解除前必须同步成功", async (t) => {
  const s = await setup(t);
  const original = s.sender;
  let rename;
  s.sender = async () => {
    await original();
    rename = t.mock.method(fs, "rename", async () => { throw new Error("登记发布失败"); });
  };
  const result = await s.send();
  assert.equal(result.outcome, "completed");
  assert.match(result.warning, /同步失败.*快照未清理/);
  assert.equal(s.chat.isBusy(), false);
  const pending = (await s.store.load("a")).pendingSend;
  assert.ok(pending);
  await assert.rejects(s.composer.dismissSend("a", pending.id), /登记发布失败/);
  assert.equal((await s.store.load("a")).pendingSend.id, pending.id);
  rename.mock.restore();
  await s.composer.dismissSend("a", pending.id);
  const saved = await s.store.load("a");
  assert.equal(saved.registration.source, "history");
  assert.equal(saved.pendingSend, null);
});

test("请求与同步同时失败保留原错误及附加提示，不改成正常完成", async (t) => {
  const s = await setup(t);
  const original = s.sender;
  s.sender = async () => {
    await original();
    t.mock.method(fs, "rename", async () => { throw new Error("同步存储失败"); });
    throw new Error("请求失败");
  };
  const result = await s.send();
  assert.equal(result.outcome, "unconfirmed");
  assert.match(result.error, /请求失败/);
  assert.match(result.warning, /同步存储失败/);
  assert.ok((await s.store.load("a")).pendingSend);
});

test("启动接线向会话、输入和聊天服务注入同一个状态存储", async () => {
  const { readFileSync } = require("node:fs");
  const { runInNewContext } = require("node:vm");
  const store = {};
  const sessions = {};
  const received = {};
  const factories = {
    createWorkspaceSettings: () => ({ load() {}, save() {} }),
    createSessionStateStore: () => store,
    createSessionService(...args) { received.sessions = args; return sessions; },
    createComposerDraftService(...args) { received.composer = args; return {}; },
    createChatService(...args) { received.chat = args; return {}; },
  };
  runInNewContext(readFileSync(path.join(__dirname, "../../src/main/bootstrap.js"), "utf8"), {
    __dirname: path.join(__dirname, "../../src/main"), module: { exports: {} },
    process: { env: {}, platform: "darwin" },
    require(name) {
      if (name === "node:path") return path;
      if (name === "node:process") return { loadEnvFile() {} };
      if (name === "electron") return { app: { getPath: () => os.tmpdir(), whenReady: () => ({ then() {} }), on() {} }, ipcMain: {} };
      return new Proxy({}, { get: (_target, key) => factories[key] ?? (() => ({})) });
    },
  });
  assert.equal(received.sessions[4], store);
  assert.equal(received.composer[1], store);
  assert.equal(received.chat[3], store);
});

test("真实SDK切换后无需编辑输入即可登记，首次发送收尾同步history", async (t) => {
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-real-sync-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const project = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    globalThis.fetch = async () => assert.fail("禁止网络和模型请求");
    const { createSessionService } = require(${JSON.stringify(path.join(project, "src/main/services/session-service.js"))});
    const { createComposerDraftService } = require(${JSON.stringify(path.join(project, "src/main/services/composer-draft-service.js"))});
    const { createChatService } = require(${JSON.stringify(path.join(project, "src/main/services/chat-service.js"))});
    const { createSessionStateStore } = require(${JSON.stringify(path.join(project, "src/main/storage/session-state-store.js"))});
    async function check() {
      const root = process.argv[1];
      const store = createSessionStateStore(path.join(root, "state"));
      const service = createSessionService(path.join(root, "sessions"), undefined,
        () => process.env.AGENT_WORKSPACE_DIR, undefined, store);
      const composer = createComposerDraftService(service, store);
      await composer.loadCurrentDraft();
      const session = await service.getSession();
      try {
        const id = session.sessionId;
        await composer.saveDraft(id, "原文", 0);
        await service.switchModel("deepseek-v4-pro");
        const switched = await store.load(id);
        assert.equal(switched.registration.model.modelId, "deepseek-v4-pro");
        assert.deepEqual(switched.draft, { text: "原文", revision: 1 });
        // 仅测试发送边界：真实SDK写入本地用户消息，不调用prompt或远程模型。
        const chat = createChatService(service, async () => async current => {
          current.sessionManager.appendMessage({ role: "user", content: "本地测试", timestamp: Date.now() });
        }, undefined, store);
        const result = await chat.send("原文", () => {}, () => {}, () => {}, { sessionId: id, revision: 1 });
        assert.equal(result.outcome, "completed");
        assert.equal((await store.load(id)).registration.source, "history");
        assert.equal((await store.load(id)).pendingSend, null);
      } finally { session.dispose(); }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await promisify(execFile)(process.execPath, ["-e", script, root], {
    env: {
      ...process.env, PI_CODING_AGENT_DIR: path.join(root, "pi-config"), PI_OFFLINE: "1",
      PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1",
      DEEPSEEK_API_KEY: "test-only-placeholder", AGENT_WORKSPACE_DIR: workspace,
    }, encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
```

## 6. 针对性验证

在项目根目录执行：

```bash
node --check src/main/services/session-service.js
node --check src/main/services/chat-service.js
node --check src/main/services/composer-draft-service.js
node --check src/main/bootstrap.js
node --test \
  tests/unit/composer-registration.test.js \
  tests/unit/composer-draft-service.test.js \
  tests/unit/session-registration.test.js \
  tests/unit/session-state-store.test.js \
  tests/unit/composer-send-state.test.js \
  tests/unit/composer-draft-ipc.test.js \
  tests/unit/session-service.test.js \
  tests/unit/session-workspace.test.js \
  tests/unit/workspace-switch.test.js \
  tests/unit/workspace-open.test.js \
  tests/unit/session-origin.test.js \
  tests/unit/workspace-session.test.js \
  tests/unit/workspace-resume.test.js \
  tests/unit/pi-agent-init.test.js \
  tests/unit/pi-workspace.test.js \
  tests/unit/model-restore.test.js \
  tests/unit/model-profiles.test.js \
  tests/unit/model-switch.test.js \
  tests/unit/registration-sync.test.js \
  tests/unit/chat-draft-lifecycle.test.js \
  tests/unit/composer-send-dismiss.test.js \
  tests/unit/chat-service.test.js \
  tests/unit/draft-send-ipc.test.js
```

候选已通过四个脚本语法检查，上述23个测试文件142项全部通过，其中独立同步专项12项。实际手写文件仍需运行同样检查。验证只使用临时配置、临时会话、模拟发送和占位凭据；真实SDK专项仅在本地临时历史追加测试用户消息，不调用prompt或远程模型，不读取本地.env或真实配置/会话。

## 本步完成后的界面与恢复边界

本步完成主进程同步及服务层重试。现有模型选择框对相同选项不触发change，本步尚未新增专用“重试登记”按钮；不能把服务层可重试记成该页面入口已经完成，后续找回入口阶段需一起处理。

来源在发送收尾时推进；版本发送在此之前已经保存pendingSend。未来恢复入口必须先找真实历史，并拒绝把仍有pendingSend的记录当成可直接重建的空会话。不能因为sync在发送结束后执行，就忽略发送中崩溃的边界。

下一步再实现同目录“未发送”入口与原编号重建，以及必要的登记错误重试展示；目录或模型失效时保留输入。之后补正常关闭前保存，才验收完整重启恢复。旧四参数发送保持兼容，当前页面继续使用已接通的版本发送路径。
