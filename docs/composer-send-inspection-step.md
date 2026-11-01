# 发送异常后的只读状态核对（手写步骤）

上一轮保存队列消费协调已由使用者完成，实际语法检查及新增9项加原有队列、读取保护和输入测试共27项全部通过。本步骤提供尚未写入项目的候选代码，继续由使用者亲手编写。

## 目标与取舍

补一个只读核对接口，在发送结果或消费确认没有传回时，读取原会话的草稿版本与未确认快照。读取时不切换会话、不清理快照、不回填输入、不请求模型。

直接重复 loadComposerDraft 不能满足需求：它只返回当前会话的草稿，不包含发送快照；原会话也可能已被切换。此次复用已有 composerDraftService 和进程内登记，不新建存储模块、不修改 bootstrap 参数。

IPC 核对使用现有 runIdleOperation：生成中拒绝核对，核对期间阻止新发送和其他会话操作，避免把尚未结束的消费误判为消费前失败。loadComposerDraft/saveComposerDraft 仍保留原独立入口，允许生成或核对期间保存新输入。返回的是读取时刻的状态，页面后续仍需核对发送凭证及当前会话，不能当作永久有效的版本许可。

本步共修改3个应用文件并新建1个测试文件。完整代码如下。

## 1. 扩展输入草稿服务

文件：`src/main/services/composer-draft-service.js`。

定位文件末尾、createComposerDraftService 函数内部的这一行：

```js
  return { loadCurrentDraft, saveDraft };
```

只把这一行替换为下面完整代码。保留外层函数结束的 `}` 和后面的 `module.exports`；inspectSend 必须与 saveDraft 同级，不要放进 saveDraft 内部。

```js
  async function inspectSend(sessionId) {
    if (!knownSessions.has(sessionId)) {
      throw new Error("该会话尚未登记，请先读取对应会话的输入草稿。");
    }

    // 使用原会话的登记；切换后的迟到核对不能改查新会话。
    const workspaceDir = knownSessions.get(sessionId);
    const state = await sessionStateStore.load(sessionId);
    if (state && state.workspaceDir !== workspaceDir) {
      throw new Error("输入草稿的工作目录与已登记目录不匹配。");
    }

    // 只给页面必要字段；读取不清理快照、不恢复原文，也不发送请求。
    return {
      sessionId,
      text: state?.draft.text ?? "",
      revision: state?.draft.revision ?? 0,
      pendingSend: state?.pendingSend ? {
        id: state.pendingSend.id,
        text: state.pendingSend.text,
        draftRevision: state.pendingSend.draftRevision,
      } : null,
    };
  }

  return { loadCurrentDraft, saveDraft, inspectSend };
```

返回结构为 `{ sessionId, text, revision, pendingSend }`；pendingSend 为 null 或 `{ id, text, draftRevision }`。text 是当前未发送输入，pendingSend.text 是之前发送的原文快照，二者不能混用。这里沿用存储中的 id 字段，不改成消费确认 DTO 中的 sendId。

## 2. 注册只读核对通道

文件：`src/main/ipc/agent-ipc.js`。

定位现有这段代码：

```js
  // 当前会话由主进程决定，页面不需要传入会话编号。
  ipcMain.handle("agent:session-info", () => sessionService.getSessionInfo());
```

在这段代码之前插入下面完整代码，现有草稿读取、保存和 session-info 保留原样。该通道只注册一次。

```js
  // 异常后的状态核对必须等生成结束，读取期间阻止新的发送与会话操作。
  ipcMain.handle("agent:inspect-composer-send", (_event, sessionId) => {
    return runIdleOperation(() => composerDraftService.inspectSend(sessionId));
  });
```

不能直接调用 service 而绕过 runIdleOperation；普通输入保存通道也不要改用此互斥入口。

## 3. 暴露受限页面接口

文件：`src/preload/preload.js`。

定位：

```js
  // 读取实际会话的模型与真实工作目录。
  getSessionInfo: () => ipcRenderer.invoke("agent:session-info"),
```

在其前面插入下面完整代码，放在 exposeInMainWorld 的 agent 对象内部，与 saveComposerDraft、getSessionInfo 同级。

```js
  // 只核对已登记的会话，不接收目录或页面提供的草稿状态。
  inspectComposerSend: (sessionId) =>
    ipcRenderer.invoke("agent:inspect-composer-send", sessionId),
```

页面以后通过 window.agent.inspectComposerSend(sessionId) 调用，只提交已登记的会话编号。

## 4. 新建专项测试

新建 `tests/unit/composer-send-inspection.test.js`，完整写入下面代码；现有测试文件保留原样。

```js
const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { runInNewContext } = require("node:vm");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-inspect-send-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "state");
  const store = createSessionStateStore(directory);
  let currentId = "a";
  let busy = false;
  let sessionReads = 0;
  let sendCalls = 0;
  const sessions = {
    async getSession() {
      sessionReads += 1;
      return { sessionId: currentId, sessionManager: { getCwd: () => root } };
    },
    async newChat() { currentId = "b"; },
  };
  const service = createComposerDraftService(sessions, store);
  const handlers = new Map();
  registerAgentIpc({
    handle(name, handler) {
      assert.equal(handlers.has(name), false, `重复注册：${name}`);
      handlers.set(name, handler);
    },
  }, sessions, {
    isBusy: () => busy,
    send() { sendCalls += 1; },
  }, undefined, undefined, undefined, undefined, undefined, service);

  return {
    root, directory, store, service,
    select(id) { currentId = id; },
    setBusy(value) { busy = value; },
    sessionReads: () => sessionReads,
    sendCalls: () => sendCalls,
    invoke: (name, ...args) => handlers.get(`agent:${name}`)({}, ...args),
  };
}

test("未登记编号不可核对，即使已有磁盘记录也不能读取", async (t) => {
  const { root, store, service } = await setup(t);
  await store.saveDraft("history", root, "私人测试原文", 0);
  await assert.rejects(service.inspectSend("a"), /尚未登记/);
  await assert.rejects(service.inspectSend("history"), /尚未登记/);
  assert.equal(await store.load("a"), null);
});

test("已登记但尚未保存时返回空状态，不创建文件", async (t) => {
  const { service, directory } = await setup(t);
  await service.loadCurrentDraft();
  assert.deepEqual(await service.inspectSend("a"), {
    sessionId: "a", text: "", revision: 0, pendingSend: null,
  });
  await assert.rejects(fs.stat(directory), { code: "ENOENT" });
});

test("完整返回未确认快照与后来输入，只读且不暴露目录和组织字段", async (t) => {
  const { root, directory, store, service } = await setup(t);
  await service.loadCurrentDraft();
  const original = " \t原文\r\n末尾 \n";
  await service.saveDraft("a", original, 0);
  const consumed = await store.consumeDraft("a", root, original, 1);
  await service.saveDraft("a", " \n下一条\t ", 2);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename);

  const result = await service.inspectSend("a");
  assert.deepEqual(result, {
    sessionId: "a", text: " \n下一条\t ", revision: 3,
    pendingSend: { id: consumed.pendingSend.id, text: original, draftRevision: 1 },
  });
  result.pendingSend.text = "修改返回对象";
  assert.deepEqual(await fs.readFile(filename), before);
  assert.equal((await service.inspectSend("a")).pendingSend.text, original);
});

test("正常收尾后返回空快照，不回填已发送输入或修改后来输入", async (t) => {
  const { root, directory, service, store } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "已发送", 0);
  const consumed = await store.consumeDraft("a", root, "已发送", 1);
  await service.saveDraft("a", "新输入", 2);
  await store.completeSend("a", root, consumed.pendingSend.id);
  const filename = path.join(directory, "a.json");
  const before = await fs.readFile(filename);
  assert.deepEqual(await service.inspectSend("a"), {
    sessionId: "a", text: "新输入", revision: 3, pendingSend: null,
  });
  assert.deepEqual(await fs.readFile(filename), before);
});

test("旧状态记录缺少 pendingSend 时按 null 返回，保留原文件字节", async (t) => {
  const { directory, service, store } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "旧输入", 0);
  const old = await store.load("a");
  delete old.pendingSend;
  const filename = path.join(directory, "a.json");
  await fs.writeFile(filename, JSON.stringify(old));
  const before = await fs.readFile(filename);
  assert.deepEqual(await service.inspectSend("a"), {
    sessionId: "a", text: "旧输入", revision: 1, pendingSend: null,
  });
  assert.deepEqual(await fs.readFile(filename), before);
});

test("切换后的迟到核对仍读取原编号，不重新查询当前会话", async (t) => {
  const { service, store, select, sessionReads } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "A 原文", 0);
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = store.load;
  t.mock.method(store, "load", async (id) => {
    if (id === "a") {
      entered.resolve();
      await released.promise;
    }
    return load(id);
  });
  const inspecting = service.inspectSend("a");
  try {
    await entered.promise;
    select("b");
    await service.loadCurrentDraft();
    await service.saveDraft("b", "B 原文", 0);
  } finally {
    released.resolve();
  }
  const count = sessionReads();
  assert.equal((await inspecting).text, "A 原文");
  assert.equal((await service.inspectSend("a")).sessionId, "a");
  assert.equal(sessionReads(), count);
  assert.equal((await load("b")).draft.text, "B 原文");
});

test("绑定不匹配或文件损坏时拒绝读取，不重置原文件", async (t) => {
  const { root, directory, store, service } = await setup(t);
  await service.loadCurrentDraft();
  await service.saveDraft("a", "保留原文", 0);
  const filename = path.join(directory, "a.json");
  const original = await store.load("a");
  await fs.writeFile(filename, JSON.stringify({ ...original, workspaceDir: path.join(root, "other") }));
  let before = await fs.readFile(filename);
  await assert.rejects(service.inspectSend("a"), /已登记目录不匹配/);
  assert.deepEqual(await fs.readFile(filename), before);
  await fs.writeFile(filename, "{损坏记录");
  before = await fs.readFile(filename);
  await assert.rejects(service.inspectSend("a"), /记录损坏/);
  assert.deepEqual(await fs.readFile(filename), before);
});

test("读取错误原样传出，显式重试仍使用原登记", async (t) => {
  const { store, service } = await setup(t);
  await service.loadCurrentDraft();
  const load = store.load;
  const failure = new Error("模拟读取失败");
  t.mock.method(store, "load", async () => { throw failure; });
  await assert.rejects(service.inspectSend("a"), (error) => error === failure);
  t.mock.method(store, "load", load);
  assert.equal((await service.inspectSend("a")).revision, 0);
});

test("IPC 在生成期间拒绝核对，但继续允许原会话输入保存", async (t) => {
  const { invoke, setBusy } = await setup(t);
  await invoke("load-composer-draft");
  setBusy(true);
  assert.throws(() => invoke("inspect-composer-send", "a"), /等待当前回复结束/);
  await invoke("save-composer-draft", "a", "生成期间的新输入", 0);
  setBusy(false);
  assert.equal((await invoke("inspect-composer-send", "a")).text, "生成期间的新输入");
});

test("IPC 核对全程阻止新发送和会话操作，失败后释放互斥，自动保存独立", async (t) => {
  const { invoke, store, sendCalls } = await setup(t);
  await invoke("load-composer-draft");
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const load = store.load;
  t.mock.method(store, "load", async () => {
    entered.resolve();
    await released.promise;
    throw new Error("模拟核对失败");
  });
  const inspecting = invoke("inspect-composer-send", "a");
  const rejected = assert.rejects(inspecting, /模拟核对失败/);
  try {
    await entered.promise;
    assert.throws(() => invoke("send-message", "不能发送"), /等待当前操作结束/);
    assert.throws(() => invoke("new-chat"), /等待当前回复结束/);
    assert.throws(() => invoke("inspect-composer-send", "a"), /等待当前回复结束/);
    await invoke("save-composer-draft", "a", "核对期间输入", 0);
    assert.equal(sendCalls(), 0);
  } finally {
    released.resolve();
    await rejected;
  }
  t.mock.method(store, "load", load);
  assert.equal((await invoke("inspect-composer-send", "a")).text, "核对期间输入");
  await invoke("new-chat");
});

test("预加载只传会话编号，原样返回核对结果和拒绝", async () => {
  let agent;
  const calls = [];
  const result = { sessionId: "a", text: "", revision: 2, pendingSend: null };
  const failure = new Error("模拟拒绝");
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { agent = value; } },
        ipcRenderer: {
          invoke(...args) {
            calls.push(args);
            return args[1] === "bad" ? Promise.reject(failure) : Promise.resolve(result);
          },
        },
      };
    },
  });
  assert.equal(await agent.inspectComposerSend("a", "/forged", { pendingSend: null }), result);
  await assert.rejects(agent.inspectComposerSend("bad"), (error) => error === failure);
  assert.deepEqual(calls, [
    ["agent:inspect-composer-send", "a"],
    ["agent:inspect-composer-send", "bad"],
  ]);
});
```

## 5. 验证

在项目根目录运行：

```bash
node --check src/main/services/composer-draft-service.js
node --check src/main/ipc/agent-ipc.js
node --check src/preload/preload.js
node --test \
  tests/unit/composer-send-inspection.test.js \
  tests/unit/composer-draft-service.test.js \
  tests/unit/composer-draft-ipc.test.js \
  tests/unit/draft-send-ipc.test.js \
  tests/unit/agent-ipc.test.js
```

候选已在临时副本通过3个脚本语法检查、11项新增测试及相关回归，共38项；与队列、读取保护和输入测试联合运行，共65项通过。实际源码和测试仍由使用者编写，完成后须重新核对。检查只使用临时文件、模拟服务及预加载环境，未读取真实会话或请求模型。

## 后续页面接入边界

- IPC 核对因忙碌而拒绝时保留等待状态；拒绝本身不能证明没有消费。
- pendingSend 为 null 可能表示没有消费，也可能表示正常完成后快照已经清理，不能仅凭此字段恢复旧输入。须同时核对本次发送凭证、原文和版本。
- 返回未确认快照不代表模型没有处理，不能自动重发，也不能把快照正文自动当成普通草稿。后续增加查看及手动处理入口。
- register 仍不会采用已有会话的新版本，不能把核对结果直接 register 就声称完成版本协调。后续须明确协调队列并保护迟到响应。
- 队列目前的消费前失败恢复只判断本地是否为空；接页面时还须用编辑记录保护后来输入后主动清空的行为。
- 当前 renderer 仍未调用持久化队列或版本发送；本步完成后仍不能称支持重启恢复。后续接页面的保存、读取与异常协调，再完成未确认快照的手动处理、空会话恢复和关闭补保存。
