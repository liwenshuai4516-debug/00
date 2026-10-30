const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

test("整理当前会话后返回摘要和保留消息，不创建新会话", async () => {
  let creations = 0;
  let compactions = 0;

  const session = {
    sessionId: "current",
    // 模拟 SDK 的事件订阅与取消订阅。
    subscribe: () => () => {},
    messages: [{ role: "user", content: "旧内容" }],

    async compact() {
      compactions += 1;

      // 模拟 SDK 完成整理后更新上下文，不请求真实模型。
      this.messages = [
        {
          role: "compactionSummary",
          summary: "已完成目录检查。",
        },
        {
          role: "user",
          content: "继续处理",
        },
      ];
    },
  };

  const service = createSessionService("unused", async () => {
    creations += 1;
    return session;
  });

  await service.getSession(true);

  const result = await service.compactSession();

  assert.equal(result.stopped, false);

  assert.deepEqual(result.history, [
    {
      role: "status",
      text: "上下文整理摘要\n已完成目录检查。",
    },
    {
      role: "user",
      text: "继续处理",
    },
  ]);

  assert.equal(await service.getSession(), session);
  assert.equal(creations, 1);
  assert.equal(compactions, 1);
});

test("SDK 整理失败时透传错误，保留当前会话", async () => {
  const session = {
    sessionId: "current",
    // 模拟 SDK 的事件订阅与取消订阅。
    subscribe: () => () => {},
    messages: [],

    async compact() {
      throw new Error("模拟整理失败");
    },
  };

  const service = createSessionService("unused", async () => session);

  await assert.rejects(service.compactSession(), /模拟整理失败/);

  assert.equal(await service.getSession(), session);
});

test("生成期间拒绝整理，空闲后不向服务转发页面参数", async () => {
  const handlers = new Map();
  let busy = true;
  let calls = 0;

  registerAgentIpc(
    {
      handle: (name, handler) => handlers.set(name, handler),
    },
    {
      async compactSession(...args) {
        // 页面不能指定其他会话或注入摘要指令。
        assert.deepEqual(args, []);
        calls += 1;
        return [];
      },
    },
    {
      isBusy: () => busy,
    },
  );

  const compact = handlers.get("agent:compact-session");

  assert.throws(() => compact({}, "other-session"), /请等待当前回复结束/);
  assert.equal(calls, 0);

  busy = false;
  assert.deepEqual(await compact({}, "other-session"), []);

  // 成功后必须释放互斥状态，允许再次进入。
  assert.deepEqual(await compact({}), []);
  assert.equal(calls, 2);
});

test("整理期间拒绝冲突操作，失败后释放互斥状态", async () => {
  const handlers = new Map();
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let newChats = 0;

  registerAgentIpc(
    {
      handle: (name, handler) => handlers.set(name, handler),
    },
    {
      compactSession() {
        started.resolve();
        return finished.promise;
      },

      newChat() {
        newChats += 1;
      },
    },
    {
      isBusy: () => false,
    },
  );

  const pending = handlers.get("agent:compact-session")({});
  await started.promise;

  // 用明确信号控制时序，不依赖固定等待时间。
  for (const channel of [
    "agent:compact-session",
    "agent:new-chat",
    "agent:open-session",
    "agent:rename-session",
    "agent:get-proposal",
    "agent:list-proposals",
    "agent:discard-proposal",
    "agent:apply-proposal",
  ]) {
    assert.throws(() => handlers.get(channel)({}, "value"), /其他操作完成/);
  }

  assert.throws(
    () => handlers.get("agent:send-message")({}, "你好"),
    /当前操作结束/,
  );

  // 先挂好拒绝断言，避免产生未处理的 Promise 拒绝。
  const rejected = assert.rejects(pending, /模拟整理失败/);
  finished.reject(new Error("模拟整理失败"));
  await rejected;

  // 整理失败后，其他操作应恢复可用。
  await handlers.get("agent:new-chat")({});
  assert.equal(newChats, 1);
});

// 模拟 SDK 的准备阶段、开始事件和可取消的整理请求。
function createControlledCompaction() {
  const preparing = Promise.withResolvers();
  const allowStart = Promise.withResolvers();
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();

  let listener;
  let ready = false;
  let aborts = 0;
  let unsubscribed = 0;

  const session = {
    sessionId: "current",
    messages: [],
    dispose() {},

    subscribe(callback) {
      listener = callback;

      return () => {
        listener = undefined;
        unsubscribed += 1;
      };
    },

    async compact() {
      preparing.resolve();
      await allowStart.promise;

      ready = true;
      listener({ type: "compaction_start" });
      started.resolve();

      await finished.promise;
    },

    abortCompaction() {
      // 模拟 SDK 在准备完成前尚不能中断整理。
      if (!ready) return;

      aborts += 1;
      finished.reject(new Error("Compaction cancelled"));
    },
  };

  return {
    session,
    preparing,
    allowStart,
    started,
    getAborts: () => aborts,
    getUnsubscribed: () => unsubscribed,
  };
}

test("初始化期间取消不进入 SDK 整理，结束后允许再次整理", async () => {
  const initializing = Promise.withResolvers();
  const initialized = Promise.withResolvers();
  let creations = 0;
  let compactions = 0;

  const session = {
    messages: [],
    subscribe: () => () => {},

    async compact() {
      compactions += 1;
    },
  };

  const service = createSessionService("unused", () => {
    creations += 1;
    initializing.resolve();
    return initialized.promise;
  });

  // 空闲取消不能意外触发会话初始化。
  service.cancelCompaction();
  assert.equal(creations, 0);

  const pending = service.compactSession();
  await initializing.promise;

  service.cancelCompaction();
  initialized.resolve(session);

  assert.deepEqual(await pending, {
    stopped: true,
    history: [],
  });
  assert.equal(compactions, 0);

  assert.deepEqual(await service.compactSession(), {
    stopped: false,
    history: [],
  });
  assert.equal(compactions, 1);
});

test("SDK 准备期间的取消在开始事件到达后仍然生效，并清理订阅", async () => {
  const controlled = createControlledCompaction();

  const service = createSessionService(
    "unused",
    async () => controlled.session,
  );

  const pending = service.compactSession();
  await controlled.preparing.promise;

  await assert.rejects(service.compactSession(), /已有上下文整理/);

  service.cancelCompaction();
  assert.equal(controlled.getAborts(), 0);

  controlled.allowStart.resolve();

  assert.deepEqual(await pending, {
    stopped: true,
    history: [],
  });
  assert.equal(controlled.getAborts(), 1);
  assert.equal(controlled.getUnsubscribed(), 1);
});

for (const source of ["取消接口", "关闭窗口"]) {
  test(`${source}可在整理进行时取消，结束后释放互斥状态`, async () => {
    const controlled = createControlledCompaction();

    const service = createSessionService(
      "unused",
      async () => controlled.session,
    );

    const handlers = new Map();
    let chatStops = 0;

    const chatService = {
      isBusy: () => false,

      async stop() {
        chatStops += 1;
      },
    };

    registerAgentIpc(
      {
        handle: (name, handler) => handlers.set(name, handler),
      },
      service,
      chatService,
    );

    const pending = handlers.get("agent:compact-session")({});
    controlled.allowStart.resolve();

    await controlled.started.promise;

    if (source === "取消接口") {
      // 取消入口不能被整理持有的互斥锁阻止。
      await handlers.get("agent:cancel-compaction")({});
    } else {
      const { EventEmitter } = require("node:events");
      const {
        registerWindowLifecycle,
      } = require("../../src/main/lifecycle/window-lifecycle.js");

      const window = new EventEmitter();

      registerWindowLifecycle(window, {
        async stop() {
          try {
            service.cancelCompaction();
          } finally {
            await chatService.stop();
          }
        },
      });

      window.emit("closed");
    }

    assert.deepEqual(await pending, {
      stopped: true,
      history: [],
    });

    assert.equal(controlled.getAborts(), 1);
    assert.equal(controlled.getUnsubscribed(), 1);
    assert.equal(chatStops, source === "关闭窗口" ? 1 : 0);

    // 操作结束后，其他会话操作应恢复可用。
    await handlers.get("agent:new-chat")({});
  });
}
