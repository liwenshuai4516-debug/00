const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const {
  createComposerDraftService,
} = require("../../src/main/services/composer-draft-service.js");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-composer-ipc-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = createSessionStateStore(path.join(root, "state"));
  const handlers = new Map();
  let currentId = "a";
  let busy = false;
  const sessions = {
    async getSession() {
      return {
        sessionId: currentId,
        sessionManager: { getCwd: () => root },
      };
    },
    async openSession(id) { currentId = id; },
  };
  registerAgentIpc(
    {
      handle(name, handler) {
        // 与 Electron 一致：同一通道不允许重复注册。
        assert.equal(handlers.has(name), false, `重复注册：${name}`);
        handlers.set(name, handler);
      },
    },    sessions,
    { isBusy: () => busy },
    undefined, undefined, undefined, undefined, undefined,
    createComposerDraftService(sessions, store),
  );
  return {
    store,
    sessions,
    setBusy(value) { busy = value; },
    invoke: (name, ...args) => handlers.get(`agent:${name}`)({}, ...args),
  };
}

test("生成期间仍可读写输入，旧的会话切换互斥保持有效", async (t) => {
  const { invoke, setBusy, store } = await setup(t);
  setBusy(true);
  // 读取不接受页面指定的会话或目录。
  assert.deepEqual(await invoke("load-composer-draft", "forged", "/forged"), {
    sessionId: "a", text: "", revision: 0,
  });
  const text = " \t中文  \r\n\n末尾 ";
  assert.deepEqual(await invoke("save-composer-draft", "a", text, 0), {
    sessionId: "a", text, revision: 1,
  });
  assert.equal((await store.load("a")).draft.text, text);
  assert.throws(() => invoke("open-session", "b"), /请等待当前回复结束/);
});

test("切换进行中允许保存旧会话输入，不写入新会话", async (t) => {
  const { invoke, sessions, store } = await setup(t);
  await invoke("load-composer-draft");
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const originalOpen = sessions.openSession;
  t.mock.method(sessions, "openSession", async (id) => {
    entered.resolve();
    await finished.promise;
    await originalOpen(id);
  });
  const opening = invoke("open-session", "b");
  // 测试失败也释放挂起的模拟切换。
  try {
    await entered.promise;
    await invoke("save-composer-draft", "a", "旧会话输入", 0);
    assert.equal((await invoke("load-composer-draft")).sessionId, "a");
  } finally {
    finished.resolve();
    await opening;
  }
  assert.equal((await invoke("load-composer-draft")).sessionId, "b");
  await invoke("save-composer-draft", "a", "迟到的新版本", 1);
  assert.equal((await store.load("a")).draft.text, "迟到的新版本");
  assert.equal(await store.load("b"), null);
});

test("通信层传递未登记与版本冲突错误，不覆盖已清空输入", async (t) => {
  const { invoke } = await setup(t);
  await assert.rejects(
    invoke("save-composer-draft", "a", "不要写入", 0), /尚未登记/,
  );
  await invoke("load-composer-draft");
  await invoke("save-composer-draft", "a", "原文", 0);
  await invoke("save-composer-draft", "a", "", 1);
  await assert.rejects(
    invoke("save-composer-draft", "a", "迟到原文", 1), /版本已变化/,
  );
  assert.deepEqual(await invoke("load-composer-draft"), {
    sessionId: "a", text: "", revision: 2,
  });
});

test("预加载只转发固定通道与必要参数，并返回结果或错误", async () => {
  let agent;
  const calls = [];
  const result = { sessionId: "a", text: "原文", revision: 3 };
  const failure = new Error("模拟保存失败");
  runInNewContext(
    readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"),
    {
      require(name) {
        assert.equal(name, "electron");
        return {
          contextBridge: {
            exposeInMainWorld(name, value) {
              assert.equal(name, "agent");
              agent = value;
            },
          },
          ipcRenderer: {
            invoke(...args) {
              calls.push(args);
              return args[0] === "agent:load-composer-draft"
                ? Promise.resolve(result)
                : Promise.reject(failure);
            },
          },
        };
      },
    },
  );
  assert.equal(await agent.loadComposerDraft("forged", "/forged"), result);
  await assert.rejects(
    agent.saveComposerDraft("a", "原文", 2, "/forged"),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    ["agent:load-composer-draft"],
    ["agent:save-composer-draft", "a", "原文", 2],
  ]);
});

test("启动入口共享输入状态存储，并将草稿服务传给 IPC", () => {
  const sessionService = {};
  const stateStore = {};
  const draftService = {};
  const modelProviderService = {};
  const promptSettingsStore = {};
  const permissionService = {};
  const workspaceChangesService = {};
  const userData = path.join(os.tmpdir(), "mock-agent-user-data");
  let storageDirectory;
  let draftArguments;
  let ipcArguments;

  const factories = {
    createExtensionUiBridge: () => ({ register() {}, cancelAll() {}, disconnect() {} }),
    createWorkspaceSettings: () => ({ load() {}, save() {} }),
    createSessionService: () => sessionService,
    createModelProviderService: () => modelProviderService,
    createPromptSettingsStore: () => promptSettingsStore,
    createPermissionService: () => permissionService,
    createSessionStateStore(directory) {
      storageDirectory = directory;
      return stateStore;
    },
    createComposerDraftService(...args) {
      draftArguments = args;
      return draftService;
    },
    createWorkspaceChangesService() {
      return workspaceChangesService;
    },
    registerAgentIpc(...args) {
      ipcArguments = args;
    },
  };

  const app = {
    getPath(name) {
      assert.equal(name, "userData");
      return userData;
    },
    // 本测试只检查组装，不创建窗口或启动 Electron。
    whenReady: () => ({ then() {} }),
    on() {},
  };
  const ipcMain = {};

  runInNewContext(
    readFileSync(path.join(__dirname, "../../src/main/bootstrap.js"), "utf8"),
    {
      __dirname: path.join(__dirname, "../../src/main"),
      module: { exports: {} },
      process: { env: {}, platform: "darwin" },
      require(name) {
        if (name === "node:path") return path;

        // 不读取真实 .env，也不加载实际业务模块。
        if (name === "node:process") return { loadEnvFile() {} };
        if (name === "electron") return { app, ipcMain };

        return new Proxy({}, {
          get(_target, key) {
            return factories[key] ?? (() => ({}));
          },
        });
      },
    },
  );

  assert.equal(storageDirectory, path.join(userData, "session-state"));
  assert.deepEqual(draftArguments, [sessionService, stateStore]);
  assert.equal(ipcArguments.length, 13);
  assert.equal(ipcArguments[0], ipcMain);
  assert.equal(ipcArguments[1], sessionService);
  assert.equal(ipcArguments[8], draftService);
  assert.equal(ipcArguments[9], modelProviderService);
  assert.equal(ipcArguments[10], promptSettingsStore);
  assert.equal(ipcArguments[11], permissionService);
  assert.equal(ipcArguments[12], workspaceChangesService);
});
