# 下一步：按原编号与登记模型重建未发送会话

状态：使用者已亲手完成，实际两个脚本语法检查及8个相关测试文件29项全部通过；仅HEAD加本次底层功能块和用户专项测试的精确提交副本也29项通过。下一小步见 `docs/unsent-session-service-step.md`；下文保留完整编写指南供对照。

## 本步目标与取舍

假设恢复对象只由主进程从已校验的session-state存储读取，页面以后只提供会话编号；本步不接页面。`recovery` 是整条状态快照，包含原 `sessionId`、真实 `workspaceDir`、`draft`、`registration` 和可选 `pendingSend`。传给底层时不改写状态文件，也不消费输入。

1. 按登记原编号优先找真实历史并核对绑定 → 验证：真实历史与分支模型优先；同编号跨目录、重复编号或错误绑定明确拒绝。
2. 没有真实历史时，只重建可信empty且有输入、没有待确认发送的会话 → 验证：保留编号、真实目录和登记模型，不造聊天消息，纯空白输入也保留。
3. 添加专项测试 → 验证：模型或配置失效时不回退默认，原输入状态和已有历史文件字节不变。

只修改下述两个底层文件，并新增一个测试文件。完整“未发送”入口、会话服务接线与正常关闭补保存留到后续小步。

## 1. 工作目录会话增加登记恢复分支

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/workspace/workspace-session.mjs`。

### 1.1 补充文件头编号复核

把现有getSessionBindingError函数的声明行替换为：

```javascript
async function getSessionBindingError(sessionPath, workspaceRoot, expectedSessionId) {
```

保留函数体。在文件头无效检查结束之后、`const bindings = entries.filter(`之前，插入：

```javascript
  if (expectedSessionId !== undefined && header.id !== expectedSessionId) {
    return "会话文件编号与恢复登记不一致。";
  }
```

列表选中的编号还需要与实际读取的文件头一致。已有普通打开和自动恢复调用不传第三参数，行为保持原样。

### 1.2 增加可选恢复快照

把createWorkspaceSession函数的参数列表替换为下面这段，保留后面的函数体：

```javascript
export async function createWorkspaceSession({
  sessionDir,
  workspaceDir,
  resume = false,
  sessionPath,
  recovery,
}) {
```

目录的realpath/stat检查保持不变。找到这一行：

```javascript
  let selectedPath = sessionPath;
```

仅把这一行替换为以下完整代码，保留紧随其后的原 `if (selectedPath) {` 分支：

```javascript
  let selectedPath = sessionPath;
  if (recovery !== undefined) {
    if (resume || sessionPath) {
      throw new Error("登记恢复不能同时指定历史路径或自动恢复。");
    }
    if (!recovery || typeof recovery.sessionId !== "string" || !recovery.sessionId) {
      throw new Error("恢复登记缺少原会话编号。");
    }
    if (recovery.workspaceDir !== workspaceRoot) {
      throw new Error("恢复登记不属于当前真实工作目录。");
    }

    // 真实历史优先；跨目录也查原编号，随后执行原有绑定检查。
    const matches = (await SessionManager.listAll(sessionDir)).filter(
      (session) => session.id === recovery.sessionId,
    );
    if (matches.length > 1) {
      throw new Error("发现多份相同编号的历史，无法确定恢复目标。");
    }
    selectedPath = matches[0]?.path;
    if (!selectedPath) {
      // 文件缺失本身不能证明为空；来源未知、历史丢失及待确认发送均拒绝重建。
      if (recovery.registration?.source !== "empty") {
        throw new Error("原会话没有可恢复历史，也没有可信的空会话登记。");
      }
      if (recovery.pendingSend != null) {
        throw new Error("该会话仍有待确认发送，不能重建为空会话。");
      }
      if (typeof recovery.draft?.text !== "string" || recovery.draft.text.length === 0) {
        throw new Error("该空会话没有待恢复的输入。");
      }
      const model = recovery.registration.model;
      if (typeof model?.provider !== "string" || !model.provider.trim() ||
          typeof model.modelId !== "string" || !model.modelId.trim()) {
        throw new Error("恢复登记缺少原模型选择。");
      }
    }
  }
```

有真实历史时，先走已有绑定校验与打开路径，不用旧快照中的empty、模型或pendingSend覆盖真实历史。没有历史时，history或未知来源均拒绝；有待确认发送时也不把它认作空会话。输入只检查length，避免丢掉纯空白原文。

### 1.3 在明确打开分支传入原编号

在紧随上面代码的第一个 `if (selectedPath) {` 内，替换getSessionBindingError调用。只改这个调用，保留后面的错误抛出：

```javascript
    const error = await getSessionBindingError(
      selectedPath,
      workspaceRoot,
      recovery?.sessionId,
    );
```

不要改resume循环里的调用；普通自动恢复没有指定原编号。

### 1.4 重建时使用原编号

在文件底部，找到原 `const manager = SessionManager.create(...)` 及它前面“没有匹配记录时新建”的注释，替换为：

```javascript
  // 普通新建使用新编号；可信空会话重建保留原编号，不伪造历史消息。
  const manager = SessionManager.create(
    workspaceRoot,
    sessionDir,
    recovery === undefined ? undefined : { id: recovery.sessionId },
  );
```

保留下方的appendCustomEntry绑定和return。SDK公开的第三参数支持指定id，并会校验编号。单独绑定和模型选择不会让空会话历史落盘，后续仍由已保存的输入状态提供恢复依据。

## 2. Pi初始化采用登记模型

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/pi-agent.mjs`。

### 2.1 第六参数接收快照

把createPiAgent函数参数列表替换为下段，保留原函数体：

```javascript
export async function createPiAgent(
  sessionDir,
  resume = false,
  sessionPath,
  workspaceDir = process.env.AGENT_WORKSPACE_DIR,
  modelSettings,
  recovery,
) {
```

第五参数仍然是modelSettings；recovery是新增的第六参数。现有四参数与五参数调用继续兼容。

### 2.2 向工作目录会话传递快照

找到原 `await createWorkspaceSession({ ... })` 调用，仅将这段解构赋值及调用替换为：

```javascript
  const { workspaceRoot, sessionManager, source } = await createWorkspaceSession({
    sessionDir,
    // 显式目录供后续选择入口使用；旧调用仍采用启动配置。
    workspaceDir,
    resume,
    sessionPath,
    recovery,
  });
```

### 2.3 区分空会话登记模型与真实历史模型

找到 `const savedSelection =` 开始、`const runtime = await ModelRuntime.create();`之前的原选择代码，替换为：

```javascript
  // 仅真正重建的空会话采用登记模型；找到历史时仍遵循原分支选择。
  const savedSelection = source === "empty" && recovery !== undefined
    ? recovery.registration.model
    : sessionManager.getBranch().findLast((entry) => entry.type === "model_change") ??
      sessionManager.buildSessionContext().model;
```

下方managed/legacy模型解析逻辑保持不变。新增配置的provider包含稳定配置编号，原resolveSelection会按原配置恢复地址与凭据；模型未登记或配置丢失明确失败，不选择同名模型、不回退默认。

## 3. 新建专项测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/empty-session-rebuild.test.js`，完整内容如下。测试只使用临时目录、占位凭据和本地消息，独立进程禁用网络；不会读取真实.env或会话，不请求模型。

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const runFile = promisify(execFile);

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "agent-empty-rebuild-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspaceDir = path.join(base, "workspace");
  const other = path.join(base, "other");
  await fs.mkdir(workspaceDir);
  await fs.mkdir(other);
  const sessionDir = path.join(base, "sessions");
  const store = createSessionStateStore(path.join(base, "state"));
  await store.registerSession("original-id", workspaceDir, "empty", {
    provider: "deepseek", modelId: "deepseek-v4-pro",
  });
  await store.saveDraft("original-id", workspaceDir, " 原输入\r\n", 0);
  const recovery = await store.load("original-id");
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  return { base, workspaceDir, other, sessionDir, store, recovery, createWorkspaceSession, SessionManager };
}

function addHistory(SessionManager, sessionDir, workspaceDir, id) {
  const manager = SessionManager.create(workspaceDir, sessionDir, { id });
  manager.appendCustomEntry("desktop-workspace-binding", { version: 1, workspaceRoot: workspaceDir });
  manager.appendModelChange("deepseek", "deepseek-flash");
  // 只追加本地测试消息令历史落盘，不调用 prompt 或任何模型。
  manager.appendMessage({ role: "user", content: "临时历史", timestamp: Date.now() });
  return manager;
}

test("按原编号及真实目录重建，不改输入与组织状态，也不伪造历史文件", async (t) => {
  const f = await setup(t);
  await f.store.update(f.recovery.sessionId, f.workspaceDir, state => ({ ...state, pinnedAt: 10, archivedAt: 20 }));
  const stateFile = path.join(f.base, "state", "original-id.json");
  const before = await fs.readFile(stateFile, "utf8");
  const alias = path.join(f.base, "alias");
  await fs.symlink(f.workspaceDir, alias);
  const result = await f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: alias, recovery: f.recovery });
  assert.equal(result.source, "empty");
  assert.equal(result.workspaceRoot, f.workspaceDir);
  assert.equal(result.sessionManager.getSessionId(), f.recovery.sessionId);
  assert.deepEqual(result.sessionManager.buildSessionContext().messages, []);
  assert.equal(result.sessionManager.getEntries().filter(e => e.type === "custom").length, 1);
  await assert.rejects(fs.stat(result.sessionManager.getSessionFile()), { code: "ENOENT" });
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
  assert.equal((await f.store.load(f.recovery.sessionId)).draft.text, " 原输入\r\n");
});

test("纯空白输入保留；来源未知或history、空输入与待确认发送不能重建", async (t) => {
  const f = await setup(t);
  const create = recovery => f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery });
  const blank = await create({ ...f.recovery, draft: { text: " \r\n\t", revision: 1 } });
  assert.equal(blank.sessionManager.getSessionId(), f.recovery.sessionId);
  for (const source of [undefined, "history"]) {
    const registration = source ? { ...f.recovery.registration, source } : undefined;
    await assert.rejects(create({ ...f.recovery, registration }), /没有可信的空会话登记/);
  }
  await assert.rejects(create({ ...f.recovery, draft: { text: "", revision: 1 } }), /没有待恢复的输入/);
  await assert.rejects(create({ ...f.recovery, pendingSend: { id: "pending" } }), /待确认发送/);
  await assert.rejects(create({ ...f.recovery, registration: { source: "empty", model: {} } }), /缺少原模型/);
});

test("真实历史优先于旧empty登记，不因待确认快照或空输入改建会话", async (t) => {
  const f = await setup(t);
  const manager = addHistory(f.SessionManager, f.sessionDir, f.workspaceDir, f.recovery.sessionId);
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  const result = await f.createWorkspaceSession({
    sessionDir: f.sessionDir, workspaceDir: f.workspaceDir,
    recovery: { ...f.recovery, draft: { text: "", revision: 2 }, pendingSend: { id: "pending" } },
  });
  assert.equal(result.source, "history");
  assert.equal(result.sessionManager.getSessionFile(), file);
  assert.equal(result.sessionManager.buildSessionContext().messages[0].content, "临时历史");
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("同编号跨目录历史拒绝绑定，不能退回重建；重复编号历史也拒绝", async (t) => {
  const f = await setup(t);
  const manager = addHistory(f.SessionManager, f.sessionDir, f.other, f.recovery.sessionId);
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  const create = () => f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery });
  await assert.rejects(create(), /属于其他工作目录/);
  assert.equal(await fs.readFile(file, "utf8"), before);
  await fs.copyFile(file, path.join(f.sessionDir, "duplicate.jsonl"));
  await assert.rejects(create(), /多份相同编号/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("无应用绑定的同编号历史拒绝认领，拒绝前不迁移原文件", async (t) => {
  const f = await setup(t);
  const manager = f.SessionManager.create(f.workspaceDir, f.sessionDir, { id: f.recovery.sessionId });
  manager.appendMessage({ role: "user", content: "旧历史", timestamp: Date.now() });
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery }), /缺少工作目录绑定/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("列表候选与实际文件编号不一致时只读拒绝，不认领另一个会话", async (t) => {
  const f = await setup(t);
  const manager = addHistory(f.SessionManager, f.sessionDir, f.workspaceDir, "another-id");
  const file = manager.getSessionFile();
  const before = await fs.readFile(file, "utf8");
  const listAll = f.SessionManager.listAll;
  // 模拟列表与后续文件头不一致；绑定检查不能只信列表中的编号。
  f.SessionManager.listAll = async () => [{ id: f.recovery.sessionId, path: file }];
  try {
    await assert.rejects(f.createWorkspaceSession({ sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery }), /文件编号与恢复登记不一致/);
    assert.equal(await fs.readFile(file, "utf8"), before);
  } finally {
    f.SessionManager.listAll = listAll;
  }
});

test("目录失效、登记目录不符、无效编号或混用恢复方式均拒绝并保留状态", async (t) => {
  const f = await setup(t);
  const stateFile = path.join(f.base, "state", "original-id.json");
  const before = await fs.readFile(stateFile, "utf8");
  const options = { sessionDir: f.sessionDir, workspaceDir: f.workspaceDir, recovery: f.recovery };
  await assert.rejects(f.createWorkspaceSession({ ...options, workspaceDir: path.join(f.base, "missing") }), { code: "ENOENT" });
  await assert.rejects(f.createWorkspaceSession({ ...options, workspaceDir: f.other }), /不属于当前真实工作目录/);
  await assert.rejects(f.createWorkspaceSession({ ...options, recovery: null }), /缺少原会话编号/);
  await assert.rejects(f.createWorkspaceSession({ ...options, recovery: { ...f.recovery, sessionId: "../bad" } }));
  await assert.rejects(f.createWorkspaceSession({ ...options, resume: true }), /不能同时指定/);
  await assert.rejects(f.createWorkspaceSession({ ...options, sessionPath: "unused" }), /不能同时指定/);
  assert.equal(await fs.readFile(stateFile, "utf8"), before);
});

test("真实SDK恢复原模型；真实历史遵循分支而非旧登记；无效模型不回退", async (t) => {
  const f = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const fs = require("node:fs/promises");
    globalThis.fetch = async () => assert.fail("测试不得请求模型或网络");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(root + "/src/main/pi-agent.mjs")});
      const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
      const base = process.argv[1], workspace = path.join(base, "workspace"), dir = path.join(base, "sessions");
      const store = createSessionStateStore(path.join(base, "state"));
      const recovery = await store.load("original-id");
      const stateFile = path.join(base, "state", "original-id.json"), before = await fs.readFile(stateFile, "utf8");
      const create = value => createPiAgent(dir, false, undefined, workspace, undefined, value);
      const first = await create(recovery);
      assert.equal(first.sessionId, recovery.sessionId);
      assert.equal(first.desktopSessionOrigin, "empty");
      assert.equal(first.model.id, "deepseek-v4-pro");
      assert.equal(first.model.baseUrl, "https://example.invalid/v1");
      assert.deepEqual(first.messages, []);
      await assert.rejects(fs.stat(first.sessionFile), { code: "ENOENT" });
      first.dispose();
      for (const model of [{ provider: "deepseek", modelId: "missing-model" }, { provider: "openai", modelId: "gpt-4" }]) {
        await assert.rejects(create({ ...recovery, registration: { source: "empty", model } }), /Pi 未找到模型|其他供应商/);
        assert.equal(await fs.readFile(stateFile, "utf8"), before);
      }
      // 同编号产生真实历史后，当前分支Flash优先于旧快照Pro。
      const manager = first.sessionManager;
      const branch = manager.getBranch().find(e => e.type === "model_change").id;
      manager.appendModelChange("deepseek", "deepseek-flash");
      const flash = manager.getLeafId();
      manager.appendModelChange("deepseek", "deepseek-v4-pro");
      manager.branch(flash);
      manager.appendMessage({ role: "user", content: "分支历史", timestamp: Date.now() });
      assert.ok(branch);
      const historyBefore = await fs.readFile(first.sessionFile, "utf8");
      const reopened = await create({ ...recovery, pendingSend: { id: "pending" } });
      assert.equal(reopened.desktopSessionOrigin, "history");
      assert.equal(reopened.model.id, "deepseek-flash");
      assert.equal(reopened.sessionId, recovery.sessionId);
      assert.equal(reopened.messages[0].content, "分支历史");
      reopened.dispose();
      assert.equal(await fs.readFile(first.sessionFile, "utf8"), historyBefore);
      assert.equal(await fs.readFile(stateFile, "utf8"), before);
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, f.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(f.base, "pi-config"), PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: f.workspaceDir },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});

test("真实SDK按配置编号重建，同名模型不串地址和凭据，配置丢失明确拒绝", async (t) => {
  const f = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const fs = require("node:fs/promises");
    globalThis.fetch = async () => assert.fail("测试不得请求模型或网络");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(root + "/src/main/pi-agent.mjs")});
      const { createModelSettingsStore, PROFILE_PREFIX } = require(${JSON.stringify(root + "/src/main/storage/model-settings-store.js")});
      const { createModelSettingsService } = require(${JSON.stringify(root + "/src/main/services/model-settings-service.js")});
      const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
      const base = process.argv[1], workspace = path.join(base, "workspace"), dir = path.join(base, "sessions");
      const settings = createModelSettingsService(createModelSettingsStore(path.join(base, "models.json"), {
        isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: buffer => buffer.toString(),
      }, { PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash" }));
      const input = { name: "A", kind: "custom", provider: "同名供应商", modelId: "same-model", baseUrl: "https://a.example.invalid/v1", authMode: "saved", apiKey: "placeholder-A", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 };
      const a = await settings.save(input);
      const b = await settings.save({ ...input, name: "B", baseUrl: "https://b.example.invalid/v1", apiKey: "placeholder-B" });
      await settings.setDefault(a.id);
      const store = createSessionStateStore(path.join(base, "state"));
      await store.registerSession("original-id", workspace, "empty", { provider: PROFILE_PREFIX + b.id, modelId: input.modelId });
      const recovery = await store.load("original-id");
      const stateFile = path.join(base, "state", "original-id.json"), before = await fs.readFile(stateFile, "utf8");
      const session = await createPiAgent(dir, false, undefined, workspace, settings, recovery);
      assert.equal(session.sessionId, recovery.sessionId);
      assert.equal(session.model.provider, PROFILE_PREFIX + b.id);
      assert.equal(session.model.baseUrl, "https://b.example.invalid/v1");
      assert.ok((await session.modelRuntime.getAuth(session.model)).auth.apiKey === "placeholder-B");
      assert.deepEqual(session.messages, []);
      await assert.rejects(fs.stat(session.sessionFile), { code: "ENOENT" });
      session.dispose();
      const missing = { ...recovery, registration: { source: "empty", model: { provider: PROFILE_PREFIX + "missing", modelId: input.modelId } } };
      await assert.rejects(createPiAgent(dir, false, undefined, workspace, settings, missing), /配置不存在/);
      assert.equal(await fs.readFile(stateFile, "utf8"), before);
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, f.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(f.base, "pi-config"), PI_OFFLINE: "1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: f.workspaceDir },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});
```

## 4. 针对性验证

在项目根目录执行：

```bash
node --check src/main/workspace/workspace-session.mjs
node --check src/main/pi-agent.mjs
node --test \
  tests/unit/empty-session-rebuild.test.js \
  tests/unit/session-origin.test.js \
  tests/unit/workspace-session.test.js \
  tests/unit/workspace-resume.test.js \
  tests/unit/pi-agent-init.test.js \
  tests/unit/pi-workspace.test.js \
  tests/unit/model-restore.test.js \
  tests/unit/model-profiles.test.js
```

临时候选已通过两个脚本语法检查和上述8个测试文件29项，其中新增专项9项。候选目录：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-empty-rebuild-candidate-s1enp40l`。这表示指南候选已验证，不表示实际手写代码或应用重启已验收。

本步完成后页面不会新增入口。下一小步再把状态读取、同目录未发送列表与恢复操作接进会话服务。届时必须显式调整bootstrap的createConfiguredAgent和默认工厂参数转发：会话服务的恢复快照不能被当作Pi的第五个modelSettings参数，也不能继续简单spread后再附加配置服务。主进程按编号读取可信快照后，应调用 `createPiAgent(sessionDir, false, undefined, workspaceDir, modelSettingsService, recovery)`；页面不能传目录、模型或快照。尚未接线前保留现有工厂。

未确认发送的专用登记重试UI、正常关闭补保存也尚未完成；本步不称为完整重启恢复。
