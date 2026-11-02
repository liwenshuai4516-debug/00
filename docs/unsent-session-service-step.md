# 下一步：未发送会话的同目录列表与恢复服务

状态：使用者已亲手完成，实际三个脚本语法检查及19文件115项全部通过；仅HEAD加本次三个主进程文件功能块和用户专项测试的精确提交副本也115项通过。下一小步见 `docs/unsent-session-ipc-step.md`；下文保留完整编写指南供对照。

## 目标与边界

底层现在能安全重建，但侧栏还不能读取和打开这些输入。本步先补主进程能力，继续由你亲手编写；页面随后接入。

假设“同目录”以当前会话的真实绑定目录为准；还没有当前会话时只读取已选目录配置，不为查列表初始化Agent。恢复只接受编号，主进程自行读取可信状态；不接受页面提供的目录、模型或快照。

1. 状态存储增加只读枚举 → 验证：等待已排队的写入，缺目录不创建，损坏数据明确报错。
2. 会话服务提供同目录列表与按编号恢复 → 验证：真实历史去重且优先打开，失败保留原会话；保存登记时不覆盖后来输入和组织状态。
3. 两个工厂显式转发模型配置与恢复快照 → 验证：默认工厂与实际启动工厂均能保留原编号、模型和配置身份。

本步只改三个主进程文件，新增两个测试文件。listSessions、普通打开历史、启动和项目自动恢复的最近消息活动规则保持原意；这里提供独立的手动入口能力。

## 1. 状态存储增加list

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/storage/session-state-store.js`。

在load函数结束之后、原 `// change 仅供主进程传入同步更新函数，不能直接暴露给页面。` 注释之前，插入完整函数：

```javascript
  // 只枚举已落盘的状态，不创建目录；每条仍经load的队列等待与校验。
  async function list() {
    await Promise.all([...pending.values()]);
    let filenames;
    try {
      filenames = await fs.readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const states = [];
    for (const filename of filenames.filter(name => name.endsWith(".json")).sort()) {
      const state = await load(filename.slice(0, -5));
      if (state) states.push(state);
    }
    return states;
  }
```

在文件底部返回对象的load后增加list，完整返回对象为：

```javascript
  return {
    load,
    list,
    update,
    registerSession,
    saveDraft,
    consumeDraft,
    completeSend,
  };
```

list返回主进程内部完整状态，后面由服务筛选为列表字段，不直接给页面。只读`.json`正式文件，忽略写入中的临时文件；任何正式文件损坏或编号不符都会报告错误，不静默伪装成空列表。枚举会等待调用时已有的写入，随后每条读取还走原load校验；它不是跨会话事务快照，枚举开始后新出现的条目在下一次刷新显示即可。

## 2. 会话服务接入同目录列表与恢复

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/services/session-service.js`。

### 2.1 默认工厂分开第五与第六参数

在文件开头，将原createDefaultAgent函数整体替换为：

```javascript
async function createDefaultAgent(sessionDir, resume, sessionPath, workspaceDir, recovery) {
  const { createPiAgent } = await import("../pi-agent.mjs");
  return createPiAgent(sessionDir, resume, sessionPath, workspaceDir, undefined, recovery);
}
```

注意两层签名不同：会话服务调用createAgent时，第五参数是恢复快照；Pi初始化的第五参数仍是modelSettings，所以默认工厂显式传undefined，再把快照放在第六参数。普通四参数调用继续兼容。

### 2.2 插入目录查询、列表与恢复三个函数

在listSessions结束之后、原 `// 只读预览：按已登记编号找到文件，不创建或切换 Agent 会话。` 注释之前，插入完整代码：

```javascript
  async function readRecoveryWorkspace() {
    // 查询列表不初始化Agent；已有会话时以实际绑定为准。
    const workspaceDir = observedSession
      ? observedSession.sessionManager.getCwd()
      : await readWorkspaceDir();
    const workspaceRoot = await realpath(workspaceDir);
    if (!(await stat(workspaceRoot)).isDirectory()) {
      throw new Error("当前工作目录必须是文件夹。");
    }
    return workspaceRoot;
  }

  async function listUnsentSessions() {
    if (!sessionStateStore) throw new Error("尚未配置会话状态存储。");
    const workspaceRoot = await readRecoveryWorkspace();
    const states = await sessionStateStore.list();
    const historyIds = new Set((await readSessions()).map(session => session.id));
    return states.filter(state =>
      state.workspaceDir === workspaceRoot &&
      state.archivedAt === null &&
      state.registration?.source === "empty" &&
      !historyIds.has(state.sessionId) &&
      (state.draft.text.length > 0 || state.pendingSend != null),
    ).map(state => ({
      id: state.sessionId,
      title: state.draft.text.trim().split(/\r?\n/, 1)[0].slice(0, 40) || "未发送对话",
      workspaceDir: workspaceRoot,
      // 待确认发送可被看见，但不得绕过底层保护直接重建。
      blockedReason: state.pendingSend ? "仍有待确认发送，暂不能重建。" : "",
    }));
  }

  // 只由后续IPC互斥入口调用；页面只给编号，不给快照、目录或模型。
  async function restoreUnsentSession(sessionId) {
    if (!sessionStateStore) throw new Error("尚未配置会话状态存储。");
    const recovery = await sessionStateStore.load(sessionId);
    if (!recovery) throw new Error("未找到该会话的输入状态，请刷新列表。");
    const workspaceRoot = await readRecoveryWorkspace();
    if (recovery.workspaceDir !== workspaceRoot) {
      throw new Error("该输入属于其他工作目录，请先打开原项目。");
    }
    if (recovery.archivedAt !== null) {
      throw new Error("该会话已归档，请先恢复归档。");
    }
    const previousSession = sessionPromise
      ? await sessionPromise.catch(() => undefined)
      : undefined;
    if (previousSession?.sessionId === sessionId) {
      const history = getHistory(previousSession);
      await syncSessionRegistration(sessionId);
      return { sessionId, workspaceDir: workspaceRoot, history };
    }

    // 第五参数是服务工厂的恢复快照；工厂负责转成Pi第六参数。
    const nextSession = await createAgent(
      sessionDir, false, undefined, workspaceRoot, recovery,
    );
    let result;
    try {
      if (nextSession.sessionId !== sessionId ||
          nextSession.sessionManager.getCwd() !== workspaceRoot) {
        throw new Error("恢复结果与原会话编号或目录不一致。");
      }
      result = { sessionId, workspaceDir: workspaceRoot, history: getHistory(nextSession) };
      const registration = captureRegistration(nextSession);
      if (!registration) throw new Error("恢复会话缺少可信来源。");
      // 与最新输入合并；历史优先打开后也及时保留history来源证明。
      await sessionStateStore.registerSession(
        sessionId, workspaceRoot, registration.source, registration.model,
      );
    } catch (error) {
      nextSession.dispose();
      throw error;
    }
    sessionPromise = Promise.resolve(observeSession(nextSession));
    previousSession?.dispose();
    return result;
  }
```

列表只包括同一真实目录、未归档、可信empty、没有真实历史且有输入或待确认快照的记录。正常空输入不显示，纯空白输入保留。已有真实历史的编号从本列表排除，仍出现在原历史列表；history或未知来源不会被叫作空会话。

返回字段只有id、输入首行标题、当前目录与blockedReason。标题只是显示摘要，输入原文仍在存储里，不截断或改写。排序沿用存储的稳定编号顺序，不伪造消息活动时间，也不改项目恢复选择。

pendingSend记录保留可见的阻塞原因；恢复仍由上一步底层检查，不能通过直接调用服务绕过保护。有真实历史时则优先原恢复链路。无历史的待确认记录如何展示和处理快照，留待页面及专门处理步骤；本步不清理或回填它。

恢复先读取状态、核对当前真实目录和归档，再准备新会话、读取历史、保存实际来源/模型，最后才替换原会话。保存登记使用原registerSession与最新状态合并；不会把recovery里的旧draft写回。重复打开当前编号保留原实例。调用失败时不自动重试或发送消息。

在createSessionService底部返回对象中，找到 `listSessions,`，紧随它新增下面两行，保留其他导出：

```javascript
    listUnsentSessions,
    restoreUnsentSession,
```

## 3. 启动工厂显式转发恢复快照

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/bootstrap.js`。

在“每次创建会话按自身记录解析配置”注释下面，将createConfiguredAgent函数整体替换为：

```javascript
async function createConfiguredAgent(sessionDir, resume, sessionPath, workspaceDir, recovery) {
  await app.whenReady();
  const { createPiAgent } = await import("./pi-agent.mjs");
  return createPiAgent(
    sessionDir, resume, sessionPath, workspaceDir, modelSettingsService, recovery,
  );
}
```

共享sessionStateStore及会话/输入/聊天服务的组装保持原样。这里必须和默认工厂同时完成：继续使用 `createPiAgent(...args, modelSettingsService)` 会把新增恢复快照误当作模型配置。

## 4. 新建状态枚举测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/session-state-list.test.js`，完整内容：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "state-list-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const directory = path.join(base, "state");
  return { base, directory, store: createSessionStateStore(directory) };
}

test("空列表不创建目录；枚举等待调用前已排队的首次保存", async (t) => {
  const { base, directory, store } = await setup(t);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
  const saving = store.saveDraft("a", base, "原文", 0);
  const states = await store.list();
  assert.deepEqual(states, [await saving]);
});

test("枚举返回完整校验后的独立快照，保留空输入、登记、组织及发送状态", async (t) => {
  const { base, directory, store } = await setup(t);
  await store.saveDraft("b", path.join(base, "other"), "", 0);
  await store.registerSession("a", base, "empty", { provider: "test", modelId: "model" });
  await store.saveDraft("a", base, "待确认原文", 0);
  await store.consumeDraft("a", base, "待确认原文", 1);
  await store.update("a", base, state => ({ ...state, pinnedAt: 1, archivedAt: 2 }));
  await fs.writeFile(path.join(directory, "a.json.partial.tmp"), "incomplete");
  const before = await fs.readFile(path.join(directory, "a.json"), "utf8");
  const result = await store.list();
  assert.deepEqual(result, [await store.load("a"), await store.load("b")]);
  result[0].pendingSend.text = "不要写回";
  assert.equal(await fs.readFile(path.join(directory, "a.json"), "utf8"), before);
  assert.equal((await createSessionStateStore(directory).list())[0].pendingSend.text, "待确认原文");
});

test("损坏内容、非法文件编号及文件头编号不符均明确拒绝，不返回假空列表", async (t) => {
  const { base, directory, store } = await setup(t);
  const valid = await store.saveDraft("a", base, "保留原文", 0);
  const filename = path.join(directory, "a.json");
  for (const text of ["{broken", JSON.stringify({ ...valid, sessionId: "wrong" })]) {
    await fs.writeFile(filename, text);
    await assert.rejects(store.list(), /损坏|归属不匹配/);
    assert.equal(await fs.readFile(filename, "utf8"), text);
  }
  await fs.writeFile(filename, JSON.stringify(valid));
  await fs.writeFile(path.join(directory, ".invalid.json"), JSON.stringify(valid));
  await assert.rejects(store.list(), /无效的会话编号/);
});

test("目录读取错误原样报告，不吞成空列表或修改已保存输入", async (t) => {
  const { base, directory, store } = await setup(t);
  await store.saveDraft("a", base, "保留原文", 0);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename, "utf8");
  const error = new Error("模拟目录不可读");
  const mock = t.mock.method(fs, "readdir", async () => { throw error; });
  try {
    await assert.rejects(store.list(), value => value === error);
  } finally {
    mock.mock.restore();
  }
  assert.equal(await fs.readFile(filename, "utf8"), before);
});
```

## 5. 新建未发送会话服务测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/unsent-session-service.test.js`，完整内容：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const runFile = promisify(execFile);
const model = { provider: "deepseek", modelId: "deepseek-v4-pro" };

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "unsent-service-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace"), other = path.join(base, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const store = createSessionStateStore(path.join(base, "state"));
  const s = { base, workspace, other, store, calls: [], sessions: [], selected: workspace };
  s.factory = async (...args) => {
    s.calls.push(args);
    s.enter?.();
    if (s.gate) await s.gate;
    if (s.failCreate) throw new Error("模拟模型失效");
    const session = {
      sessionId: s.wrongId ? "wrong-id" : args[4]?.sessionId ?? "active",
      desktopSessionOrigin: s.unknownSource ? undefined : s.history ? "history" : "empty",
      model: { provider: model.provider, id: model.modelId },
      sessionManager: {
        getCwd: () => s.wrongDirectory ? s.other : args[3],
        getEntries: () => [],
      },
      get messages() {
        if (s.failHistory) throw new Error("模拟历史读取失败");
        return s.history ? [{ role: "user", content: "历史优先" }] : [];
      },
      disposed: false,
      dispose() { this.disposed = true; },
    };
    s.sessions.push(session);
    return session;
  };
  s.service = createSessionService(path.join(base, "sessions"), s.factory, () => s.selected, undefined, store);
  s.save = async (id, text, source = "empty", workspaceDir = workspace) => {
    await store.registerSession(id, workspaceDir, source, model);
    return store.saveDraft(id, workspaceDir, text, 0);
  };
  return s;
}

test("列表不创建Agent，只列同目录可信empty，真实历史去重并标明待确认发送", async (t) => {
  const s = await setup(t);
  await s.save("a", " 第一行\n第二行");
  await s.save("blank", " \t\r\n");
  await s.save("empty", "");
  await s.save("history-source", "历史输入", "history");
  await s.save("other", "其他目录", "empty", s.other);
  await s.store.saveDraft("unknown", s.workspace, "未知来源", 0);
  await s.save("archived", "归档输入");
  await s.store.update("archived", s.workspace, state => ({ ...state, archivedAt: 1 }));
  await s.save("pending", "发送原文");
  await s.store.consumeDraft("pending", s.workspace, "发送原文", 1);
  await s.save("real-history", "旧empty快照");
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const history = await createWorkspaceSession({ sessionDir: path.join(s.base, "sessions"), workspaceDir: s.workspace, recovery: await s.store.load("real-history") });
  history.sessionManager.appendMessage({ role: "user", content: "本地历史", timestamp: Date.now() });
  const before = await s.store.list();
  assert.deepEqual(await s.service.listUnsentSessions(), [
    { id: "a", title: "第一行", workspaceDir: s.workspace, blockedReason: "" },
    { id: "blank", title: "未发送对话", workspaceDir: s.workspace, blockedReason: "" },
    { id: "pending", title: "未发送对话", workspaceDir: s.workspace, blockedReason: "仍有待确认发送，暂不能重建。" },
  ]);
  assert.equal(s.calls.length, 0);
  assert.deepEqual(await s.store.list(), before);
});

test("已有会话时目录以实际绑定为准，配置改变不把其他目录混入列表", async (t) => {
  const s = await setup(t);
  const current = await s.service.getSession();
  await s.save("a", "本目录");
  await s.save("b", "其他目录", "empty", s.other);
  s.selected = s.other;
  assert.deepEqual((await s.service.listUnsentSessions()).map(row => row.id), ["a"]);
  assert.equal(await s.service.getSession(), current);
  assert.equal(s.calls.length, 1);
});

test("恢复后才释放原会话；新旧会话输入独立，迟到保存不串会话", async (t) => {
  const s = await setup(t);
  const composer = createComposerDraftService(s.service, s.store);
  const old = await composer.loadCurrentDraft();
  const previous = await s.service.getSession();
  await composer.saveDraft(old.sessionId, "旧会话输入", 0);
  const original = await s.save("target", " 原输入\r\n");
  const result = await s.service.restoreUnsentSession("target");
  assert.deepEqual(result, { sessionId: "target", workspaceDir: s.workspace, history: [] });
  assert.equal(previous.disposed, true);
  assert.deepEqual(s.calls[1], [path.join(s.base, "sessions"), false, undefined, s.workspace, original]);
  assert.deepEqual(await composer.loadCurrentDraft(), { sessionId: "target", text: " 原输入\r\n", revision: 1 });
  await composer.saveDraft(old.sessionId, "旧会话迟到输入", 1);
  assert.equal((await s.store.load("target")).draft.text, original.draft.text);
  assert.equal((await s.store.load(old.sessionId)).draft.text, "旧会话迟到输入");
});

test("重复打开当前编号不重建、不释放，也不改输入版本", async (t) => {
  const s = await setup(t);
  const current = await s.service.getSession();
  const before = await s.save(current.sessionId, "保留输入");
  await s.service.restoreUnsentSession(current.sessionId);
  assert.equal(await s.service.getSession(), current);
  assert.equal(current.disposed, false);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(await s.store.load(current.sessionId), before);
});

test("编号不存在、其他目录及归档拒绝恢复，不替换原会话", async (t) => {
  const s = await setup(t);
  const previous = await s.service.getSession();
  await s.save("other", "保留", "empty", s.other);
  await s.save("archived", "保留");
  await s.store.update("archived", s.workspace, state => ({ ...state, archivedAt: 1 }));
  const before = await s.store.list();
  for (const [id, error] of [["missing", /未找到/], ["../bad", /无效的会话编号/], ["other", /其他工作目录/], ["archived", /已归档/]]) {
    await assert.rejects(s.service.restoreUnsentSession(id), error);
  }
  assert.deepEqual(await s.store.list(), before);
  assert.equal(await s.service.getSession(), previous);
  assert.equal(previous.disposed, false);
  assert.equal(s.calls.length, 1);
});

test("创建、历史、编号、目录、可信来源及登记保存失败均保留旧会话，释放候选", async (t) => {
  const s = await setup(t);
  const previous = await s.service.getSession();
  await s.save("target", "保留输入");
  const filename = path.join(s.base, "state", "target.json"), before = await fs.readFile(filename, "utf8");
  for (const flag of ["failCreate", "failHistory", "wrongId", "wrongDirectory", "unknownSource", "failRegistration"]) {
    s[flag] = true;
    const size = s.sessions.length;
    const register = s.store.registerSession;
    if (flag === "failRegistration") s.store.registerSession = async () => { throw new Error("模拟登记写入失败"); };
    try {
      await assert.rejects(s.service.restoreUnsentSession("target"));
      assert.equal(await s.service.getSession(), previous);
      assert.equal(previous.disposed, false);
      assert.equal(await fs.readFile(filename, "utf8"), before);
      if (s.sessions.length > size) assert.equal(s.sessions.at(-1).disposed, true);
    } finally {
      s.store.registerSession = register;
      s[flag] = false;
    }
  }
});

test("准备恢复期间的新输入与组织字段合并保留，历史来源及时推进", async (t) => {
  const s = await setup(t);
  await s.service.getSession();
  await s.save("target", "旧快照");
  let release;
  s.gate = new Promise(resolve => { release = resolve; });
  s.history = true;
  let markEntered;
  const entered = new Promise(resolve => { markEntered = resolve; });
  s.enter = markEntered;
  const restoring = s.service.restoreUnsentSession("target");
  // 等待工厂进入异步准备，随后模拟原会话的迟到输入保存。
  await entered;
  await s.store.saveDraft("target", s.workspace, "后来输入", 1);
  await s.store.update("target", s.workspace, state => ({ ...state, pinnedAt: 100 }));
  release();
  assert.deepEqual((await restoring).history, [{ role: "user", text: "历史优先" }]);
  const after = await s.store.load("target");
  assert.deepEqual(after.draft, { text: "后来输入", revision: 2 });
  assert.equal(after.pinnedAt, 100);
  assert.equal(after.registration.source, "history");
});

test("目录失效与未注入存储时明确拒绝，保留输入而不初始化Agent", async (t) => {
  const s = await setup(t);
  await s.save("target", "保留输入");
  await fs.rmdir(s.workspace);
  await assert.rejects(s.service.listUnsentSessions(), { code: "ENOENT" });
  await assert.rejects(s.service.restoreUnsentSession("target"), { code: "ENOENT" });
  assert.equal((await s.store.load("target")).draft.text, "保留输入");
  assert.equal(s.calls.length, 0);
  const bare = createSessionService("unused");
  await assert.rejects(bare.listUnsentSessions(), /尚未配置会话状态存储/);
  await assert.rejects(bare.restoreUnsentSession("target"), /尚未配置会话状态存储/);
});

test("默认工厂接通真实SDK：原编号原模型、历史优先和拒绝不安全重建", async (t) => {
  const s = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises");
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
    globalThis.fetch = async () => assert.fail("不得请求模型或网络");
    async function check() {
      const base = process.argv[1], workspace = path.join(base, "workspace"), dir = path.join(base, "sessions");
      const store = createSessionStateStore(path.join(base, "state"));
      const make = () => createSessionService(dir, undefined, () => workspace, undefined, store);
      const service = make(), previous = await service.getSession();
      const model = { provider: "deepseek", modelId: "deepseek-v4-pro" };
      await store.registerSession("target", workspace, "empty", model);
      await store.saveDraft("target", workspace, " 原输入\\r\\n", 0);
      const before = await store.load("target");
      await service.restoreUnsentSession("target");
      const restored = await service.getSession();
      assert.equal(restored.sessionId, "target");assert.equal(restored.model.id, model.modelId);
      assert.deepEqual(restored.messages, []);
      await assert.rejects(fs.stat(restored.sessionFile), { code: "ENOENT" });
      assert.deepEqual(await store.load("target"), before);
      // 记录损坏来源/模型或待确认发送时均拒绝，原会话保持可用。
      for (const [id, source, selection, pending] of [
        ["missing-model", "empty", { ...model, modelId: "not-registered" }, false],
        ["lost-history", "history", model, false],
        ["pending", "empty", model, true],
      ]) {
        await store.registerSession(id, workspace, source, selection);
        await store.saveDraft(id, workspace, "保留", 0);
        if (pending) await store.consumeDraft(id, workspace, "保留", 1);
        const saved = await store.load(id);
        await assert.rejects(service.restoreUnsentSession(id));
        assert.equal(await service.getSession(), restored);
        assert.deepEqual(await store.load(id), saved);
      }
      restored.sessionManager.appendModelChange("deepseek", "deepseek-flash");
      restored.sessionManager.appendMessage({ role: "user", content: "临时真实历史", timestamp: Date.now() });
      restored.dispose();
      const reopen = make();
      await reopen.restoreUnsentSession("target");
      const real = await reopen.getSession();
      assert.equal(real.model.id, "deepseek-flash");assert.equal(real.messages[0].content, "临时真实历史");
      assert.equal((await store.load("target")).registration.source, "history");
      assert.equal((await reopen.listUnsentSessions()).some(row => row.id === "target"), false);
      real.dispose(); previous.dispose();
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, s.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(s.base, "pi-config"), PI_OFFLINE: "1", PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash", PI_BASE_URL: "https://example.invalid/v1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: s.workspace },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});

test("实际启动工厂正确分开配置服务与恢复快照，按原配置恢复同名模型", async (t) => {
  const s = await setup(t);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict"), path = require("node:path"), fs = require("node:fs/promises");
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
    const { createModelSettingsStore, PROFILE_PREFIX } = require(${JSON.stringify(root + "/src/main/storage/model-settings-store.js")});
    const { createModelSettingsService } = require(${JSON.stringify(root + "/src/main/services/model-settings-service.js")});
    globalThis.fetch = async () => assert.fail("不得请求模型或网络");
    async function check() {
      const base = process.argv[1], workspace = path.join(base, "workspace");
      const settings = createModelSettingsService(createModelSettingsStore(path.join(base, "models.json"), {
        isEncryptionAvailable: () => true, encryptString: value => Buffer.from(value), decryptString: buffer => buffer.toString(),
      }, { PI_PROVIDER: "deepseek", PI_MODEL: "deepseek-flash" }));
      const input = { name: "A", kind: "custom", provider: "同名供应商", modelId: "same", baseUrl: "https://a.example.invalid/v1", authMode: "saved", apiKey: "placeholder-A", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 };
      const a = await settings.save(input), b = await settings.save({ ...input, name: "B", baseUrl: "https://b.example.invalid/v1", apiKey: "placeholder-B" });
      await settings.setDefault(a.id);
      // 提取实际启动文件中的工厂，仅重定位动态导入；不执行bootstrap或读取.env。
      const source = await fs.readFile(${JSON.stringify(root + "/src/main/bootstrap.js")}, "utf8");
      const begin = source.indexOf("async function createConfiguredAgent("), end = source.indexOf("\\n\\n// 在应用入口", begin);
      const factorySource = source.slice(begin, end).replace('import("./pi-agent.mjs")', 'import(' + JSON.stringify(${JSON.stringify(root + "/src/main/pi-agent.mjs")}) + ')');
      let ready = 0;
      const factory = new Function("app", "modelSettingsService", "return (" + factorySource + ");")({ whenReady: async () => { ready += 1; } }, settings);
      const store = createSessionStateStore(path.join(base, "state"));
      await store.registerSession("target", workspace, "empty", { provider: PROFILE_PREFIX + b.id, modelId: "same" });
      await store.saveDraft("target", workspace, "保留输入", 0);
      const service = createSessionService(path.join(base, "sessions"), factory, () => workspace, undefined, store);
      await service.restoreUnsentSession("target");
      const restored = await service.getSession();
      assert.equal(restored.sessionId, "target");assert.equal(restored.model.provider, PROFILE_PREFIX + b.id);
      assert.equal(restored.model.baseUrl, "https://b.example.invalid/v1");
      assert.ok((await restored.modelRuntime.getAuth(restored.model)).auth.apiKey === "placeholder-B");
      assert.equal(ready, 1);assert.deepEqual(restored.messages, []);
      assert.equal((await store.load("target")).draft.text, "保留输入");
      restored.dispose();
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  await runFile(process.execPath, ["-e", script, s.base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(s.base, "pi-config"), PI_OFFLINE: "1", DEEPSEEK_API_KEY: "test-placeholder", AGENT_WORKSPACE_DIR: s.workspace },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
});
```

## 6. 验证

在项目根目录执行：

```bash
node --check src/main/storage/session-state-store.js
node --check src/main/services/session-service.js
node --check src/main/bootstrap.js
node --test \
  tests/unit/session-state-list.test.js \
  tests/unit/unsent-session-service.test.js \
  tests/unit/empty-session-rebuild.test.js \
  tests/unit/session-origin.test.js \
  tests/unit/workspace-session.test.js \
  tests/unit/workspace-resume.test.js \
  tests/unit/pi-agent-init.test.js \
  tests/unit/pi-workspace.test.js \
  tests/unit/model-restore.test.js \
  tests/unit/model-profiles.test.js \
  tests/unit/session-state-store.test.js \
  tests/unit/session-service.test.js \
  tests/unit/session-workspace.test.js \
  tests/unit/workspace-open.test.js \
  tests/unit/workspace-switch.test.js \
  tests/unit/composer-registration.test.js \
  tests/unit/composer-draft-service.test.js \
  tests/unit/registration-sync.test.js \
  tests/unit/composer-draft-ipc.test.js
```

临时候选已通过三个脚本语法检查及上述19个文件115项，其中新增专项14项。候选目录：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-unsent-service-advice-bf2w8uyu`。真实SDK检查只初始化临时会话、设置模型和追加本地测试消息；占位凭据、独立临时配置并禁用网络，不读取真实.env、配置或会话，不请求模型。启动工厂检查只提取实际工厂并重定位动态导入，不启动真实应用。

完成后页面还没有新增“未发送”入口。下一步先接受runIdleOperation保护的IPC与有限preload接口，再把同目录列表及恢复接到新深色侧栏。届时必须在离开前等待当前输入保存，恢复成功后绑定新编号并调用原bindComposer读取最新输入，避免从列表标题或旧快照回填；失败保留原展示。正常关闭补保存尚未完成，完整重启恢复仍待后续验收。
