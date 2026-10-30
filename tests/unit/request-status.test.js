const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  getRequestStatus,
} = require("../../src/main/adapters/request-status.js");
const {
  createChatService,
} = require("../../src/main/services/chat-service.js");
const {
  registerAgentIpc,
} = require("../../src/main/ipc/agent-ipc.js");

test("重试状态显示次数与间隔，不回显原始错误", () => {
  const text = getRequestStatus({
    type: "auto_retry_start",
    attempt: 1,
    maxAttempts: 3,
    delayMs: 1500,
    errorMessage: "private-error-data",
  });

  assert.match(text, /1\/3/);
  assert.match(text, /2 秒/);
  assert.doesNotMatch(text, /private-error-data/);

  assert.match(
    getRequestStatus({
      type: "auto_retry_end",
      success: true,
    }),
    /已恢复/,
  );

  assert.match(
    getRequestStatus({
      type: "auto_retry_end",
      success: false,
    }),
    /已结束/,
  );
});

test("上下文整理状态覆盖开始、停止、失败和重新请求", () => {
  assert.match(
    getRequestStatus({ type: "compaction_start" }),
    /正在整理/,
  );

  const cases = [
    [{ aborted: true }, /已停止/],
    [{ errorMessage: "测试错误" }, /失败/],
    [{ willRetry: true }, /重新请求/],
    [{ willRetry: false }, /继续处理/],
  ];

  for (const [details, expected] of cases) {
    assert.match(
      getRequestStatus({
        type: "compaction_end",
        ...details,
      }),
      expected,
    );
  }

  // 普通消息不应被误转换成请求状态。
  assert.equal(
    getRequestStatus({ type: "message_update" }),
    undefined,
  );
});

test("Pi 适配器转发状态，成功和失败后均取消订阅", async () => {
  const { sendMessage } = await import(
    "../../src/main/pi-agent.mjs"
  );

  for (const fail of [false, true]) {
    const received = [];
    let listener;
    let unsubscribed = 0;

    // 模拟 SDK 会话，不调用真实模型。
    const session = {
      agent: { state: {} },

      subscribe(callback) {
        listener = callback;

        return () => {
          unsubscribed += 1;
        };
      },

      async prompt() {
        listener({
          type: "auto_retry_start",
          attempt: 1,
          maxAttempts: 2,
          delayMs: 1000,
        });

        listener({ type: "compaction_start" });

        if (fail) {
          throw new Error("模拟请求失败");
        }
      },
    };

    const pending = sendMessage(
      session,
      "测试",
      () => {},
      () => {},
      (text) => received.push(text),
    );

    if (fail) {
      await assert.rejects(pending, /模拟请求失败/);
    } else {
      await pending;
    }

    assert.equal(received.length, 2);
    assert.match(received[0], /自动重试/);
    assert.match(received[1], /正在整理/);
    assert.equal(unsubscribed, 1);
  }
});

test("聊天停止后忽略后续状态，并释放忙碌状态", async () => {
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const received = [];

  const service = createChatService(
    {
      getSession: async () => ({
        abort: async () => finished.resolve(),
      }),
    },
    async () =>
      async (_session, _text, _onText, _onTool, onStatus) => {
        onStatus("重试中");
        started.resolve();

        await finished.promise;
        onStatus("停止后的事件");
      },
  );

  const pending = service.send(
    "测试",
    () => {},
    () => {},
    (text) => received.push(text),
  );

  // 使用明确信号控制时序，不依赖固定等待时间。
  await started.promise;
  await service.stop();

  assert.deepEqual(await pending, { stopped: true });
  assert.deepEqual(received, ["重试中"]);
  assert.equal(service.isBusy(), false);
});

test("IPC 只向发起请求且尚未销毁的页面发送状态", async () => {
  const handlers = new Map();
  const sent = [];
  let destroyed = false;

  registerAgentIpc(
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {},
    {
      isBusy: () => false,

      async send(_text, _onText, _onTool, onStatus) {
        onStatus("正在重试");

        destroyed = true;
        onStatus("页面已关闭");
      },
    },
  );

  // 模拟 Electron 发送方，无需启动桌面窗口。
  const event = {
    sender: {
      isDestroyed: () => destroyed,
      send: (channel, text) => sent.push([channel, text]),
    },
  };

  await handlers.get("agent:send-message")(event, "测试");

  assert.deepEqual(sent, [
    ["agent:request-status", "正在重试"],
  ]);
});