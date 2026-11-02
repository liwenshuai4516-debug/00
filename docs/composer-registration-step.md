# 下一步：输入保存与恢复登记在同次写入中完成

状态：本指南为下一步手写候选，实际应用尚未接入。使用者已完成上一小步的会话来源标识，实际两个脚本语法检查及7文件20项测试通过；仅HEAD加来源功能块的精确提交副本也20项通过。

## 本步目标与范围

输入正文、输入版本和恢复登记必须在同一次状态更新中落盘。登记只使用主进程确认的原编号、真实目录、可信来源和实际运行时的模型标识。由于保存可能排队，模型与来源应在排到本次写入时读取，不能在排队前固定一个可能过时的模型。

计划：

1. 会话服务提供同步、只读的登记信息 → 验证：当前会话实时读取；离开后仅保留小型元数据快照；未成功采用的候选不登记。
2. 状态存储在更新队列内部读取登记，与输入原子保存 → 验证：版本冲突、目录不匹配、无效模型或发布失败时原状态不变。
3. 输入服务传入原会话编号对应的读取回调 → 验证：切到B后迟到保存A仍归A，同编号重新打开后取最新实例。

本步只修改 `session-service.js`、`session-state-store.js`、`composer-draft-service.js`，新增专项测试；不扩展IPC或preload，也不改页面。继续由你亲手编写。

本步只保证“每次输入保存时同步登记”。已保存输入后只切换模型而不再编辑、首次发消息后没有后续输入保存，这两条独立同步路径仍需下一小步接入，不能提前开启空会话重建。

## 1. 会话服务提供可信登记信息

文件：`src/main/services/session-service.js`。

在createSessionService内部找到：

```javascript
  let sessionPromise;
  let activeCompaction;
```

保留这两行，在其后、原“初始化、新建和打开历史共用目录来源”注释之前插入以下完整代码：

```javascript
  // 只保留一个当前会话；已离开的会话仅保存小型元数据快照。
  let observedSession;
  const registrations = new Map();

  function captureRegistration(session) {
    const origin = session.desktopSessionOrigin;
    // 缺少可信来源时保持未知，兼容旧调用，但不提供空会话重建证明。
    if (origin !== "empty" && origin !== "history") return undefined;

    const hasConversation = session.sessionManager.getEntries().some(
      (entry) => entry.type === "message" &&
        ["user", "assistant"].includes(entry.message?.role),
    );
    return {
      workspaceDir: session.sessionManager.getCwd(),
      source: origin === "history" || hasConversation ? "history" : "empty",
      model: { provider: session.model?.provider, modelId: session.model?.id },
    };
  }

  function observeSession(session) {
    if (observedSession && observedSession !== session) {
      registrations.set(observedSession.sessionId, captureRegistration(observedSession));
    }
    observedSession = session;
    return session;
  }

  // 同步读取，不初始化、不切换；仅供主进程的状态更新回调使用。
  function readSessionRegistration(sessionId) {
    const registration = observedSession?.sessionId === sessionId
      ? captureRegistration(observedSession)
      : registrations.get(sessionId);
    return registration ? {
      ...registration, model: { ...registration.model },
    } : undefined;
  }
```

说明：创建时来源为history则始终视为历史；原本empty的会话只要已出现真实user/assistant消息，保存时就推进history。缺少可信来源保持未知，不靠文件当前是否存在猜测。runtime provider保留配置编号，不使用getSessionInfo的展示用provider。

再修改getSession中的初始化Promise。找到：

```javascript
      sessionPromise = Promise.resolve()
        .then(() => createSession(resume))
        .catch((error) => {
          sessionPromise = undefined;
          throw error;
        });
```

将这一整段替换为：

```javascript
      sessionPromise = Promise.resolve()
        .then(() => createSession(resume))
        .then(observeSession)
        .catch((error) => {
          sessionPromise = undefined;
          throw error;
        });
```

然后在以下四个方法中分别找到同一行：openSession、newChat、switchWorkspace、openWorkspace。

```javascript
    sessionPromise = Promise.resolve(nextSession);
```

四处均只替换这一行为：

```javascript
    sessionPromise = Promise.resolve(observeSession(nextSession));
```

保留各方法现有的前置准备和previousSession.dispose顺序。特别是目录配置保存成功后才观察新会话；不要将observeSession移到候选创建后或配置保存前，否则切换失败会让登记误指向未采用的会话。

最后在返回对象中，将：

```javascript
    getSession,
    loadHistory,
```

替换为：

```javascript
    getSession,
    readSessionRegistration,
    loadHistory,
```

这是主进程内部接口，不新增IPC通道。readSessionRegistration不初始化会话、不创建历史、不请求模型，返回小型副本。Map不持有离开会话的完整上下文，迟到保存仍能拿到原会话最后实际选择。

## 2. 状态存储在同次更新中保存登记

文件：`src/main/storage/session-state-store.js`。

将原 `async function saveDraft(...)` 从函数声明开始到对应结束大括号整体替换为以下代码；替换边界到下一段 `async function consumeDraft(...)` 之前，consumeDraft保持不变：

```javascript
  async function saveDraft(
    sessionId, workspaceDir, text, expectedRevision, readRegistration,
  ) {
    if (typeof text !== "string" || !isRevision(expectedRevision)) {
      throw new Error("输入草稿或版本无效。");
    }

    if (readRegistration !== undefined && typeof readRegistration !== "function") {
      throw new Error("会话登记读取方法无效。");
    }

    return update(sessionId, workspaceDir, (state) => {
      if (state.draft.revision !== expectedRevision) {
        throw new Error("输入草稿版本已变化，请重新读取后再保存。");
      }

      // 到达写入队列时才读取，避免排队期间的旧模型覆盖实际选择。
      const registration = readRegistration?.();
      let nextRegistration = state.registration;
      if (registration !== undefined) {
        validateRegistration(registration);
        if (registration.workspaceDir !== workspaceDir) {
          throw new Error("会话恢复登记的工作目录不匹配。");
        }
        nextRegistration = {
          source: state.registration?.source === "history" ? "history" : registration.source,
          model: {
            provider: registration.model.provider,
            modelId: registration.model.modelId,
          },
        };
      }

      return {
        ...state,
        // 空字符串也是明确保存，不能删除版本，否则旧输入可能重新写回。
        draft: { text, revision: expectedRevision + 1 },
        ...(nextRegistration === undefined ? {} : { registration: nextRegistration }),
      };
    });
  }
```

第五参数是主进程传入的同步读取函数，不是页面提交的数据。保留原四参数调用兼容性；没有可信登记时仍可保存原输入，已有登记不会被删除。它返回的workspaceDir必须与原草稿归属相符。

登记读取发生在旧版本检查之后、同一次update回调内部；写入只复制source和model标识。输入和登记一起通过原有临时文件同步后rename，不拆成registerSession和saveDraft两次写入。任何一步失败都不会出现“新输入版本已保存，但恢复登记仍旧”的半完成状态。

## 3. 输入服务按原编号提供读取回调

文件：`src/main/services/composer-draft-service.js`。

将原 `async function saveDraft(sessionId, text, expectedRevision)` 整个函数替换为：

```javascript
  async function saveDraft(sessionId, text, expectedRevision) {
    if (!knownSessions.has(sessionId)) {
      throw new Error("该会话尚未登记，请先读取对应会话的输入草稿。");
    }

    // 允许切换后的延迟保存，始终使用原会话已登记的目录。
    const state = await sessionStateStore.saveDraft(
      sessionId,
      knownSessions.get(sessionId),
      text,
      expectedRevision,
      // 回调只查原编号；在同次状态写入中读取来源和实际模型。
      typeof sessionService.readSessionRegistration === "function"
        ? () => sessionService.readSessionRegistration(sessionId)
        : undefined,
    );

    return {
      sessionId,
      text: state.draft.text,
      revision: state.draft.revision,
    };
  }
```

保留loadCurrentDraft、inspectSend、dismissSend。旧Map仍只登记编号和目录，异步保存不重新绑定到当前会话。没有内部读取接口的旧模拟服务继续按原行为运行；缺少可信信息也不会被认证为空会话。

## 4. 新建专项测试

新建 `tests/unit/composer-registration.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-composer-registration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const directory = path.join(root, "state");
  const store = createSessionStateStore(directory);
  const state = { root, workspace, directory, store, agents: [], failSettings: false };
  state.sessions = createSessionService("unused", async (_dir, _resume, _file, cwd) => {
    const index = state.agents.length;
    const agent = {
      sessionId: `session-${index}`,
      desktopSessionOrigin: "empty",
      model: { provider: `desktop-profile-${index}`, id: "chat-model" },
      entries: [], messages: [], disposed: false,
      sessionManager: { getCwd: () => cwd, getEntries: () => agent.entries },
      dispose() { agent.disposed = true; },
    };
    state.agents.push(agent);
    return agent;
  }, () => workspace, async () => {
    if (state.failSettings) throw new Error("模拟目录配置保存失败");
  });
  state.composer = createComposerDraftService(state.sessions, store);
  state.first = await state.sessions.getSession();
  await state.composer.loadCurrentDraft();
  return state;
}

function addUser(agent) {
  agent.entries.push({ type: "message", message: { role: "user", content: "测试消息" } });
}

test("首次读取不落盘，保存同时登记原编号、目录和实际配置模型", async (t) => {
  const s = await setup(t);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
  s.first.model = { provider: "desktop-profile-selected", id: "selected-model" };
  const text = " \t输入\r\n\n ";
  assert.deepEqual(await s.composer.saveDraft(s.first.sessionId, text, 0), {
    sessionId: s.first.sessionId, text, revision: 1,
  });
  const saved = await s.store.load(s.first.sessionId);
  assert.equal(saved.workspaceDir, s.workspace);
  assert.deepEqual(saved.registration, {
    source: "empty", model: { provider: "desktop-profile-selected", modelId: "selected-model" },
  });
  assert.deepEqual(await createSessionStateStore(s.directory).load(s.first.sessionId), saved);
});

test("排队期间切换模型，在实际写入时读取最新选择", async (t) => {
  const s = await setup(t);
  const rename = fs.rename;
  let entered;
  let release;
  const started = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  let firstRename = true;
  t.mock.method(fs, "rename", async (...args) => {
    if (firstRename) {
      firstRename = false;
      entered();
      await gate;
    }
    return rename(...args);
  });
  const blocking = s.store.update(s.first.sessionId, s.workspace, state => ({ ...state, pinnedAt: 10 }));
  await started;
  const saving = s.composer.saveDraft(s.first.sessionId, "排队输入", 0);
  s.first.model = { provider: "desktop-profile-latest", id: "latest" };
  release();
  await blocking;
  await saving;
  const state = await s.store.load(s.first.sessionId);
  assert.equal(state.registration.model.provider, "desktop-profile-latest");
  assert.equal(state.pinnedAt, 10);
  assert.deepEqual(state.draft, { text: "排队输入", revision: 1 });
});

test("切到 B 后延迟保存 A，仍使用 A 最后实际来源与模型", async (t) => {
  const s = await setup(t);
  s.first.model.id = "a-final";
  addUser(s.first);
  await s.sessions.newChat();
  await s.composer.loadCurrentDraft();
  const second = s.agents[1];
  assert.equal(s.first.disposed, true);
  // 已离开的会话应只保留小型快照，不能让旧实例变化影响 B 或已冻结的登记。
  s.first.model.id = "disposed-object-change";
  await s.composer.saveDraft(s.first.sessionId, "A 迟到输入", 0);
  await s.composer.saveDraft(second.sessionId, "B 输入", 0);
  const a = await s.store.load(s.first.sessionId);
  const b = await s.store.load(second.sessionId);
  assert.deepEqual(a.registration, {
    source: "history", model: { provider: "desktop-profile-0", modelId: "a-final" },
  });
  assert.equal(b.registration.source, "empty");
  assert.equal(b.registration.model.provider, "desktop-profile-1");
  assert.equal(a.draft.text, "A 迟到输入");
  assert.equal(b.draft.text, "B 输入");
});

test("来源只向 history 推进，保存不触碰发送快照和组织状态", async (t) => {
  const s = await setup(t);
  const id = s.first.sessionId;
  await s.composer.saveDraft(id, "原文", 0);
  const consumed = await s.store.consumeDraft(id, s.workspace, "原文", 1);
  await s.store.update(id, s.workspace, state => ({ ...state, pinnedAt: 5, archivedAt: 6 }));
  addUser(s.first);
  await s.composer.saveDraft(id, "后续输入", 2);
  s.first.entries = [];
  await s.composer.saveDraft(id, "", 3);
  const state = await s.store.load(id);
  assert.equal(state.registration.source, "history");
  assert.deepEqual(state.draft, { text: "", revision: 4 });
  assert.deepEqual(state.pendingSend, consumed.pendingSend);
  assert.equal(state.pinnedAt, 5);
  assert.equal(state.archivedAt, 6);
});

test("原本打开历史的会话即使缺少消息也不登记为空，未知来源不补 empty", async (t) => {
  const s = await setup(t);
  s.first.desktopSessionOrigin = "history";
  await s.composer.saveDraft(s.first.sessionId, "历史输入", 0);
  assert.equal((await s.store.load(s.first.sessionId)).registration.source, "history");
  await s.sessions.newChat();
  const second = s.agents[1];
  delete second.desktopSessionOrigin;
  await s.composer.loadCurrentDraft();
  await s.composer.saveDraft(second.sessionId, "保留未知输入", 0);
  assert.equal((await s.store.load(second.sessionId)).registration, undefined);
});

test("无效模型、目录不匹配与旧版本均不写入原文或登记", async (t) => {
  const s = await setup(t);
  const id = s.first.sessionId;
  await s.composer.saveDraft(id, "旧原文", 0);
  const filename = path.join(s.directory, `${id}.json`);
  const before = await fs.readFile(filename, "utf8");
  const originalModel = s.first.model;
  s.first.model = null;
  await assert.rejects(s.composer.saveDraft(id, "新原文", 1), /恢复登记无效/);
  s.first.model = originalModel;
  await assert.rejects(s.store.saveDraft(id, s.workspace, "新原文", 1, () => ({
    ...s.sessions.readSessionRegistration(id), workspaceDir: path.join(s.root, "other"),
  })), /登记的工作目录不匹配/);
  await assert.rejects(s.store.saveDraft(id, s.workspace, "旧版本", 0, () => {
    assert.fail("版本冲突时不应再读取登记");
  }), /版本已变化/);
  assert.equal(await fs.readFile(filename, "utf8"), before);
});

test("发布失败原文和登记都保留，使用同一版本重试可保存最新模型", async (t) => {
  const s = await setup(t);
  const id = s.first.sessionId;
  await s.composer.saveDraft(id, "已保存原文", 0);
  const filename = path.join(s.directory, `${id}.json`);
  const before = await fs.readFile(filename, "utf8");
  s.first.model.id = "next-model";
  const mock = t.mock.method(fs, "rename", async () => { throw new Error("模拟发布失败"); });
  await assert.rejects(s.composer.saveDraft(id, "未保存输入", 1), /模拟发布失败/);
  assert.equal(await fs.readFile(filename, "utf8"), before);
  mock.mock.restore();
  await s.composer.saveDraft(id, "重试输入", 1);
  const state = await s.store.load(id);
  assert.equal(state.registration.model.modelId, "next-model");
  assert.deepEqual(state.draft, { text: "重试输入", revision: 2 });
});

test("切换目录准备失败仍读取原会话，不登记未采用的候选", async (t) => {
  const s = await setup(t);
  s.failSettings = true;
  await assert.rejects(s.sessions.switchWorkspace(s.workspace), /模拟目录配置保存失败/);
  assert.equal(s.agents[1].disposed, true);
  assert.equal(s.sessions.readSessionRegistration(s.first.sessionId).model.provider, "desktop-profile-0");
  assert.equal(s.sessions.readSessionRegistration(s.agents[1].sessionId), undefined);

});

test("模型切换部分失败后，下一次输入保存取实际模型；返回副本不可改内部登记", async (t) => {
  const s = await setup(t);
  s.first.desktopModelSettings = {
    async switchProfile(agent) {
      agent.model = { provider: "desktop-profile-partial", id: "partial-model" };
      throw new Error("模拟更新后失败");
    },
  };
  await assert.rejects(s.sessions.switchModelProfile("selected"), /模拟更新后失败/);
  const descriptor = s.sessions.readSessionRegistration(s.first.sessionId);
  descriptor.model.provider = "caller-change";
  await s.composer.saveDraft(s.first.sessionId, "保留实际选择", 0);
  assert.equal((await s.store.load(s.first.sessionId)).registration.model.provider, "desktop-profile-partial");
});


test("真实 SDK 重新打开同编号后，保存使用新实例的实际来源和模型", async (t) => {
  const { promisify } = require("node:util");
  const { execFile } = require("node:child_process");
  const runFile = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-real-registration-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace);
  const project = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    globalThis.fetch = async () => assert.fail("测试禁止访问网络和模型");
    const { createSessionService } = require(${JSON.stringify(path.join(project, "src/main/services/session-service.js"))});
    const { createComposerDraftService } = require(${JSON.stringify(path.join(project, "src/main/services/composer-draft-service.js"))});
    const { createSessionStateStore } = require(${JSON.stringify(path.join(project, "src/main/storage/session-state-store.js"))});
    async function check() {
      const root = process.argv[1];
      const sessions = createSessionService(path.join(root, "sessions"));
      const store = createSessionStateStore(path.join(root, "state"));
      const composer = createComposerDraftService(sessions, store);
      await composer.loadCurrentDraft();
      const first = await sessions.getSession();
      const id = first.sessionId;
      await composer.saveDraft(id, "原输入", 0);
      first.sessionManager.appendMessage({ role: "user", content: "本地测试消息", timestamp: Date.now() });
      await sessions.newChat();
      await composer.loadCurrentDraft();
      await sessions.openSession(id);
      await composer.loadCurrentDraft();
      const reopened = await sessions.getSession();
      try {
        assert.notEqual(reopened, first);
        await sessions.switchModel("deepseek-v4-pro");
        await composer.saveDraft(id, "重新打开后的输入", 1);
        const saved = await store.load(id);
        assert.equal(saved.registration.source, "history");
        assert.equal(saved.registration.model.provider, "deepseek");
        assert.equal(saved.registration.model.modelId, "deepseek-v4-pro");
        assert.deepEqual(saved.draft, { text: "重新打开后的输入", revision: 2 });
      } finally {
        reopened.dispose();
      }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runFile(process.execPath, ["-e", script, root], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(root, "pi-config"),
      PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash",
      PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "test-placeholder",
      AGENT_WORKSPACE_DIR: workspace,
    },
    encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
```

## 5. 执行验证

在项目根目录执行以下检查。候选三个脚本语法检查通过，以下18个相关测试文件共99项全部通过，其中本步新增10项。

```bash
node --check src/main/services/session-service.js
node --check src/main/storage/session-state-store.js
node --check src/main/services/composer-draft-service.js
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
  tests/unit/model-switch.test.js
```

验证使用临时配置、临时会话和占位凭据，不读取本地.env、真实配置或真实会话，不请求模型。真实SDK专项只在临时目录直接追加本地测试消息，用于触发历史写出；这不是应用中的实现方案。候选验证不代表实际手写文件已经通过，完成后请运行以上命令。

## 本步完成后仍需接入

- 模型或配置切换后的登记同步：即使用户没有继续编辑输入，也要保存最终实际选择；SDK部分更新后报错同样需核对实际状态，存储失败可重试。
- 首次真实消息产生后的history推进：不能依赖用户恰好再输入一条；需覆盖正常回复、主动停止、失败和文件已生成后的异常，并保留待确认发送快照语义。
- 上述同步完成后，才实现同目录未发送列表和按原编号重建；真实历史优先，历史丢失不得冒充空会话。
- 最后补正常关闭前保存。完整重启恢复仍未完成。

本指南不代替上述后续工作。项目打开仍按最近消息活动恢复，输入保存不改变其活动时间规则。
