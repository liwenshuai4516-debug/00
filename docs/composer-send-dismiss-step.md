# 未确认发送：用户核对后的解除接口（手写步骤）

页面项目回调与重复body标签已由使用者修正，实际renderer语法检查和14项Electron模拟检查通过。输入按会话保存、发送确认、异常核对和原文只读查看已经接通。本步补充后端独立动作，让用户在核对历史与原文后，明确选择解除该会话的发送限制；继续由使用者亲手写代码和测试。

## 假设、范围和成功标准

- “解除”只表示用户不再保留这份阻塞发送的快照，不证明远端模型处理成功。快照原文会被移除，未来页面必须明确提示并让用户先核对或自行保留需要的原文，再确认处理。
- 仅处理已登记会话及指定发送编号。编号不匹配或快照已不存在时拒绝，不能清理更新的发送记录。
- 比较与修改放在既有sessionStateStore.update的同会话串行入口内，保留后来输入、草稿版本、置顶归档和其他字段，不改Pi历史或工作文件。
- 操作与生成、项目切换、文件草稿操作共用runIdleOperation；输入自动保存仍独立可用。
- 成功只返回{sessionId,sendId}，不返回可能已经过期的输入正文。失败不能让页面误报已解除；请求返回丢失时，后续页面应先重新核对实际pendingSend，再决定是否重试。
- 本步只增加服务、IPC、preload和专项测试，不先添加页面按钮，也不从保存重试、初始化或发送失败处理自动调用该动作。

步骤：新增服务动作 → 接受互斥保护的固定通信通道 → 增加预加载方法 → 写专项测试并验证。无需修改bootstrap或状态存储，也不改既有completeSend的正常收尾语义。

## 1. 输入服务新增dismissSend

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/services/composer-draft-service.js`。

在文件底部找到下面一行（当前工厂函数的右大括号也写在这一行）：

```js
  return { loadCurrentDraft, saveDraft, inspectSend };}
```

将这一行整体替换为下面完整代码。保留后面的 `module.exports = { createComposerDraftService };`，不要再额外添加工厂函数结束括号：

```js
  // 只由用户明确确认后的独立入口调用，不代表模型已经成功处理。
  async function dismissSend(sessionId, sendId) {
    if (!knownSessions.has(sessionId)) {
      throw new Error("该会话尚未登记，请先读取对应会话的输入草稿。");
    }
    if (typeof sendId !== "string" || !sendId) {
      throw new Error("发送编号无效。");
    }

    const workspaceDir = knownSessions.get(sessionId);
    await sessionStateStore.update(sessionId, workspaceDir, (state) => {
      // 在串行更新内部比较编号，迟到的确认不能清理较新的发送记录。
      if (state.pendingSend?.id !== sendId) {
        throw new Error("发送记录已变化，请重新核对后再处理。");
      }

      // 不回填原文，不改草稿版本、组织状态，也不接触Pi历史。
      return { ...state, pendingSend: null };
    });

    // 不返回可能已经过期的草稿正文，页面继续保留自己的最新编辑。
    return { sessionId, sendId };
  }

  return { loadCurrentDraft, saveDraft, inspectSend, dismissSend };
}
```

必须在update的回调里检查发送编号。不要先inspect再无条件写入；自动保存或其他收尾可能在两次操作之间更新状态。当前登记已经绑定原会话目录，切换后的迟到处理仍属于原会话，不重新查询后来打开的会话。

## 2. 新增受互斥保护的IPC

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/ipc/agent-ipc.js`。

找到这一条注释：

```js
  // 只读当前会话的模型目录，不接受页面指定供应商或会话。
```

在这条注释之前插入下面完整代码。原注释及下面的list-models接口保留；新通道只注册一次：

```js
  // 用户明确核对后解除限制；生成和其他会话操作期间不可执行。
  ipcMain.handle("agent:dismiss-composer-send", (_event, sessionId, sendId) => {
    return runIdleOperation(() => composerDraftService.dismissSend(sessionId, sendId));
  });
```

不能直接绕过runIdleOperation调用服务。用户核对期间或实际解除过程中，不能让新发送、切换或文件操作交叉执行；保存后来输入仍经过原有独立草稿保存接口。

## 3. 预加载暴露有限方法

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/preload/preload.js`。

找到下面的注释，在其之前插入新方法，原注释和后面的listModels保持原状：

```js
  // 页面只读取模型编号和名称，实际目录由主进程提供。
```

```js
  // 仅提交明确确认的会话和发送编号，不接受目录、原文或状态对象。
  dismissComposerSend: (sessionId, sendId) =>
    ipcRenderer.invoke("agent:dismiss-composer-send", sessionId, sendId),
```

页面最终通过 `window.agent.dismissComposerSend(sessionId, sendId)` 调用。方法只转发两个编号，不接受目录、原文、草稿状态或额外参数。预加载不持有“已确认”的业务判断；未来页面的独立确认流程负责触发。

## 4. 新建完整专项测试

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/composer-send-dismiss.test.js`，写入下面全部代码；必须放在tests/unit，不能放在tests根目录：

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
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-dismiss-send-"));
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

  async function seed(id = "a") {
    currentId = id;
    await service.loadCurrentDraft();
    await service.saveDraft(id, " \t待核对原文\r\n", 0);
    return store.consumeDraft(id, root, " \t待核对原文\r\n", 1);
  }

  return {
    root, directory, store, service, seed,
    filename: (id) => path.join(directory, `${id}.json`),
    select(id) { currentId = id; },
    setBusy(value) { busy = value; },
    sessionReads: () => sessionReads,
    sendCalls: () => sendCalls,
    invoke: (name, ...args) => handlers.get(`agent:${name}`)({}, ...args),
  };
}

test("未登记会话不能解除限制，即使磁盘已有快照也不改写", async (t) => {
  const s = await setup(t);
  await s.store.saveDraft("other", s.root, "原文", 0);
  const consumed = await s.store.consumeDraft("other", s.root, "原文", 1);
  const before = await fs.readFile(s.filename("other"));
  await assert.rejects(s.service.dismissSend("other", consumed.pendingSend.id), /尚未登记/);
  assert.deepEqual(await fs.readFile(s.filename("other")), before);
  assert.equal(s.sessionReads(), 0);
});

test("无效发送编号或不存在的快照不创建状态文件", async (t) => {
  const s = await setup(t);
  await s.service.loadCurrentDraft();
  for (const id of [undefined, null, "", 0, {}]) {
    await assert.rejects(s.service.dismissSend("a", id), /发送编号无效/);
  }
  await assert.rejects(s.service.dismissSend("a", "missing"), /发送记录已变化/);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
});

test("明确解除只清理匹配快照，保留原文草稿、版本、组织状态及历史字节", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  await s.service.saveDraft("a", " \t后来输入\r\n\n ", 2);
  await s.store.update("a", s.root, (state) => ({ ...state, pinnedAt: 12, archivedAt: 34 }));
  const before = await s.store.load("a");
  const history = path.join(s.root, "history.jsonl");
  await fs.writeFile(history, "仅用于核对不改写的测试历史\n");
  const historyBefore = await fs.readFile(history);
  const reads = s.sessionReads();

  assert.deepEqual(await s.service.dismissSend("a", consumed.pendingSend.id), {
    sessionId: "a", sendId: consumed.pendingSend.id,
  });
  assert.deepEqual(await s.store.load("a"), { ...before, pendingSend: null });
  assert.deepEqual(await fs.readFile(history), historyBefore);
  assert.equal(s.sessionReads(), reads);
  assert.equal(s.sendCalls(), 0);
});

test("错误编号、重复确认或迟到的旧确认不能清理另一份快照", async (t) => {
  const s = await setup(t);
  const first = await s.seed();
  let before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", "wrong"), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  await s.service.dismissSend("a", first.pendingSend.id);
  before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", first.pendingSend.id), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);

  await s.service.saveDraft("a", "新一轮原文", 2);
  const next = await s.store.consumeDraft("a", s.root, "新一轮原文", 3);
  before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", first.pendingSend.id), /发送记录已变化/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  assert.equal((await s.store.load("a")).pendingSend.id, next.pendingSend.id);
});

test("切换后仍按原登记处理A，不查询当前会话或修改B", async (t) => {
  const s = await setup(t);
  const a = await s.seed("a");
  await s.seed("b");
  const before = await fs.readFile(s.filename("b"));
  const reads = s.sessionReads();
  await s.service.dismissSend("a", a.pendingSend.id);
  assert.equal((await s.store.load("a")).pendingSend, null);
  assert.deepEqual(await fs.readFile(s.filename("b")), before);
  assert.equal(s.sessionReads(), reads);
});

test("自动保存与解除共用串行更新，任一顺序均保留新输入和版本", async (t) => {
  for (const saveFirst of [true, false]) {
    const s = await setup(t);
    const consumed = await s.seed();
    const save = () => s.service.saveDraft("a", "  新输入\n", 2);
    const dismiss = () => s.service.dismissSend("a", consumed.pendingSend.id);
    await Promise.all(saveFirst ? [save(), dismiss()] : [dismiss(), save()]);
    const state = await s.store.load("a");
    assert.deepEqual(state.draft, { text: "  新输入\n", revision: 3 });
    assert.equal(state.pendingSend, null);
  }
});

test("目录归属错误或损坏文件拒绝解除，保留原文件字节", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  const state = await s.store.load("a");
  await fs.writeFile(s.filename("a"), JSON.stringify({ ...state, workspaceDir: path.join(s.root, "other") }));
  let before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", consumed.pendingSend.id), /工作目录不匹配/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  await fs.writeFile(s.filename("a"), "{损坏状态");
  before = await fs.readFile(s.filename("a"));
  await assert.rejects(s.service.dismissSend("a", consumed.pendingSend.id), /记录损坏/);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
});

test("发布失败保留快照和旧文件，清理临时文件后可显式重试", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  const before = await fs.readFile(s.filename("a"));
  const rename = fs.rename;
  const failure = new Error("模拟解除写入失败");
  const mocked = t.mock.method(fs, "rename", async (from, to) => {
    if (to === s.filename("a")) throw failure;
    return rename(from, to);
  });
  await assert.rejects(s.service.dismissSend("a", consumed.pendingSend.id), (error) => error === failure);
  assert.deepEqual(await fs.readFile(s.filename("a")), before);
  assert.deepEqual(await fs.readdir(s.directory), ["a.json"]);
  mocked.mock.restore();
  await s.service.dismissSend("a", consumed.pendingSend.id);
  assert.equal((await s.store.load("a")).pendingSend, null);
});

test("IPC生成期间拒绝解除，保存仍可执行；空闲后按编号解除且不发送", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  s.setBusy(true);
  assert.throws(() => s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id), /等待当前回复结束/);
  await s.invoke("save-composer-draft", "a", "生成中的新输入", 2);
  assert.equal((await s.store.load("a")).pendingSend.id, consumed.pendingSend.id);
  s.setBusy(false);
  assert.deepEqual(await s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id), {
    sessionId: "a", sendId: consumed.pendingSend.id,
  });
  assert.deepEqual((await s.store.load("a")).draft, { text: "生成中的新输入", revision: 3 });
  assert.equal(s.sendCalls(), 0);
});

test("IPC处理期间阻止发送与切换，写入失败后释放互斥供重试", async (t) => {
  const s = await setup(t);
  const consumed = await s.seed();
  const entered = Promise.withResolvers();
  const released = Promise.withResolvers();
  const dismiss = s.service.dismissSend;
  const mocked = t.mock.method(s.service, "dismissSend", async () => {
    entered.resolve();
    await released.promise;
    throw new Error("模拟解除失败");
  });
  const working = s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id);
  const rejected = assert.rejects(working, /模拟解除失败/);
  try {
    await entered.promise;
    assert.throws(() => s.invoke("send-message", "不能发送"), /等待当前操作结束/);
    assert.throws(() => s.invoke("new-chat"), /等待当前回复结束/);
    assert.throws(() => s.invoke("inspect-composer-send", "a"), /等待当前回复结束/);
    await s.invoke("save-composer-draft", "a", "解除等待期间的新输入", 2);
    assert.equal(s.sendCalls(), 0);
  } finally {
    released.resolve();
    await rejected;
    mocked.mock.restore();
  }
  assert.equal(s.service.dismissSend, dismiss);
  await s.invoke("dismiss-composer-send", "a", consumed.pendingSend.id);
  assert.deepEqual((await s.store.load("a")).draft, { text: "解除等待期间的新输入", revision: 3 });
  await s.invoke("new-chat");
});

test("预加载固定通道仅转发两个编号，结果及拒绝原样返回", async () => {
  let agent;
  const calls = [];
  const result = { sessionId: "a", sendId: "s1" };
  const failure = new Error("模拟解除拒绝");
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require(name) {
      assert.equal(name, "electron");
      return {
        contextBridge: { exposeInMainWorld(_name, value) { agent = value; } },
        ipcRenderer: {
          invoke(...args) {
            calls.push(args);
            return args[2] === "bad" ? Promise.reject(failure) : Promise.resolve(result);
          },
        },
      };
    },
  });
  assert.equal(await agent.dismissComposerSend("a", "s1", "/forged", { pendingSend: null }), result);
  await assert.rejects(agent.dismissComposerSend("a", "bad"), (error) => error === failure);
  assert.deepEqual(calls, [
    ["agent:dismiss-composer-send", "a", "s1"],
    ["agent:dismiss-composer-send", "a", "bad"],
  ]);
});
```

测试使用临时状态目录和模拟会话，覆盖未登记、无快照、无效/错误/重复/迟到编号、目录归属与损坏状态、保留后续草稿、跨会话、两种并发保存顺序、发布失败与重试、IPC互斥和有限预加载参数。

## 5. 验证

在项目根目录依次执行：

```bash
node --check src/main/services/composer-draft-service.js
node --check src/main/ipc/agent-ipc.js
node --check src/preload/preload.js
```

```bash
node --test \
  tests/unit/composer-send-dismiss.test.js \
  tests/unit/composer-send-inspection.test.js \
  tests/unit/composer-draft-service.test.js \
  tests/unit/session-state-store.test.js \
  tests/unit/composer-send-state.test.js \
  tests/unit/chat-draft-lifecycle.test.js \
  tests/unit/draft-send-ipc.test.js \
  tests/unit/agent-ipc.test.js
```

预期67项全部通过，其中本步新增11项。无需请求真实模型、使用真实会话或手动在控制台清理真实快照；页面按钮下一步再接。正常聊天、新输入保存与项目打开继续使用原入口。

## 验证记录与下一步

候选副本：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-dismiss-wqevv6_i`，使用实际服务/IPC/preload作为基线，三个脚本语法检查和上述67项通过。

另在仅有已提交代码加本步三个功能块与专项测试的隔离副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-dismiss-isolated-zwvdwxnf` 验证同样67项，排除工作区model-settings等其他未提交功能。全部使用临时文件与模拟会话，未请求模型或读取真实配置/会话。

以上是候选验证，本步实际业务代码和新测试未由助手创建；用户编写后仍需核对实际文件。下一步再给当前深色页面的确认按钮、快照清理后的组件状态同步、失败后的重新核对及界面验收。页面不能用返回的旧正文覆盖后来编辑，不能自动解除或重发；重复调用被拒绝时先核对，不能盲目把旧编号换成当前快照编号。

解除接口与页面收尾后，再继续空会话登记和重建、正常关闭补保存。输入恢复整体尚未完成，会话置顶归档与上下文常驻入口按总设计随后实施。
