const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const { EventEmitter } = require("node:events");
const { runInNewContext } = require("node:vm");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const {
  createSessionStateStore,
} = require("../../src/main/storage/session-state-store.js");

function register(chat, sessions = {}) {
  const handlers = new Map();
  registerAgentIpc({
    handle(name, handler) {
      assert.equal(handlers.has(name), false, `重复注册：${name}`);
      handlers.set(name, handler);
    },
  }, sessions, chat);
  return handlers;
}

function loadPreload(invoke) {
  let agent;
  const events = new EventEmitter();

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
            invoke,
            on: (...args) => events.on(...args),
            removeListener: (...args) => events.removeListener(...args),
          },
        };
      },
    },
  );

  return { agent, events };
}

test("IPC 保留原文，只转发版本字段，消费确认只发给请求来源", async () => {
  const sent = [];
  const other = [];
  const ack = { sessionId: "a", sendId: "send-1", text: "", revision: 2 };
  const result = { stopped: false, outcome: "completed", draft: ack };
  const text = "  原文\r\n末尾 ";

  const handlers = register({
    isBusy: () => false,
    async send(message, _onText, _onTool, _onStatus, metadata, onConsumed) {
      assert.equal(message, text);
      assert.deepEqual(metadata, { sessionId: "a", revision: 1 });
      onConsumed({ ...ack, workspaceDir: "/不应传给页面" });
      return result;
    },
  });

  const sender = {
    isDestroyed: () => false,
    send: (...args) => sent.push(args),
  };
  const otherSender = { send: (...args) => other.push(args) };
  const actual = await handlers.get("agent:send-message")(
    { sender, otherSender }, text,
    { sessionId: "a", revision: 1, workspaceDir: "/forged" },
  );

  assert.equal(actual, result);
  assert.deepEqual(sent, [["agent:draft-consumed", ack]]);
  assert.deepEqual(other, []);
});

test("请求来源销毁后不发送确认，服务仍可返回完成结果", async () => {
  let destroyed = false;
  const ready = Promise.withResolvers();
  const entered = Promise.withResolvers();

  const handlers = register({
    isBusy: () => false,
    async send(_text, _onText, _onTool, _onStatus, _draft, onConsumed) {
      entered.resolve();
      await ready.promise;
      onConsumed({ sessionId: "a", sendId: "s1", text: "", revision: 2 });
      return { stopped: false, outcome: "completed" };
    },
  });

  const pending = handlers.get("agent:send-message")({
    sender: {
      isDestroyed: () => destroyed,
      send: () => assert.fail("页面已销毁，不应再发送确认"),
    },
  }, "原文", { sessionId: "a", revision: 1 });

  try {
    await entered.promise;
    destroyed = true;
  } finally {
    ready.resolve();
  }

  assert.equal((await pending).outcome, "completed");
});

test("其他互斥操作期间仍拒绝携带输入版本的发送", async () => {
  const finished = Promise.withResolvers();
  let sends = 0;

  const handlers = register({
    isBusy: () => false,
    send() { sends += 1; },
  }, { newChat: () => finished.promise });

  const opening = handlers.get("agent:new-chat")({});
  try {
    assert.throws(() => handlers.get("agent:send-message")(
      {}, "原文", { sessionId: "a", revision: 1 },
    ), /当前操作结束/);
    assert.equal(sends, 0);
  } finally {
    finished.resolve();
    await opening;
  }
});

for (const uncertain of [false, true]) {
  test(`真实服务贯通 IPC：${uncertain ? "未确认" : "完成但清理失败"}结果不被改写`, async (t) => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-send-ipc-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const store = createSessionStateStore(root);
    const text = "  原文\n";
    await store.saveDraft("a", root, text, 0);

    const sessions = {
      getSession: async () => ({
        sessionId: "a",
        sessionManager: { getCwd: () => root },
      }),
    };

    if (!uncertain) {
      t.mock.method(store, "completeSend", async () => {
        throw new Error("模拟清理失败");
      });
    }

    const chat = createChatService(sessions, async () => async () => {
      await store.saveDraft("a", root, "下一条输入", 2);
      if (uncertain) throw new Error("连接中断");
    }, undefined, store);

    const handlers = register(chat, sessions);
    const sent = [];
    const result = await handlers.get("agent:send-message")({
      sender: {
        isDestroyed: () => false,
        send: (...args) => sent.push(args),
      },
    }, text, { sessionId: "a", revision: 1 });

    assert.equal(result.outcome, uncertain ? "unconfirmed" : "completed");
    if (uncertain) assert.match(result.error, /连接中断/);
    else assert.match(result.warning, /模拟清理失败/);
    assert.deepEqual(sent, [["agent:draft-consumed", result.draft]]);

    const state = await store.load("a");
    assert.equal(state.pendingSend.text, text);
    assert.equal(state.draft.text, "下一条输入");
  });
}

test("预加载限定发送参数，兼容原调用，返回结果和错误", async () => {
  const calls = [];
  const result = { outcome: "unconfirmed", error: "测试结果" };
  const failure = new Error("模拟消费前失败");

  const { agent } = loadPreload((...args) => {
    calls.push(structuredClone(args));
    return args[1] === "失败"
      ? Promise.reject(failure)
      : Promise.resolve(result);
  });

  assert.equal(await agent.sendMessage("  原文 "), result);
  assert.equal(await agent.sendMessage("  原文 ", {
    sessionId: "a", revision: 1, workspaceDir: "/forged",
  }, "/extra"), result);
  assert.equal(await agent.sendMessage("  原文 ", undefined, {
    workspaceChanges: true,
  }), result);

  await agent.sendMessage("原文", null);
  await assert.rejects(
    agent.sendMessage("失败"),
    (error) => error === failure,
  );

  assert.deepEqual(calls, [
    ["agent:send-message", "  原文 ", undefined, { workspaceChanges: false }],
    ["agent:send-message", "  原文 ", { sessionId: "a", revision: 1 }, { workspaceChanges: false }],
    ["agent:send-message", "  原文 ", undefined, { workspaceChanges: true }],
    ["agent:send-message", "原文", {
      sessionId: undefined, revision: undefined,
    }, { workspaceChanges: false }],
    ["agent:send-message", "失败", undefined, { workspaceChanges: false }],
  ]);
});

test("消费确认订阅仅传数据，取消时只移除自己的监听器", () => {
  const { agent, events } = loadPreload(() => Promise.resolve());
  const first = [];
  const second = [];

  const offFirst = agent.onDraftConsumed((...args) => first.push(args));
  const offSecond = agent.onDraftConsumed((...args) => second.push(args));
  const ack = { sessionId: "a", sendId: "s1", text: "", revision: 2 };
  const event = { sender: "不能暴露给页面" };

  events.emit("agent:draft-consumed", event, ack);
  offFirst();
  events.emit("agent:draft-consumed", event, ack);
  offSecond();

  assert.deepEqual(first, [[ack]]);
  assert.deepEqual(second, [[ack], [ack]]);
  assert.equal(events.listenerCount("agent:draft-consumed"), 0);
});