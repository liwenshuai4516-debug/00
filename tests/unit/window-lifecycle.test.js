const { test } = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const {
  registerWindowLifecycle,
} = require("../../src/main/lifecycle/window-lifecycle.js");
const {
  createChatService,
} = require("../../src/main/services/chat-service.js");

test("窗口关闭时停止一次，隐藏窗口不触发停止", () => {
  const window = new EventEmitter();
  let stops = 0;

  registerWindowLifecycle(window, {
    async stop() {
      stops += 1;
    },
  });

  window.emit("hide");
  assert.equal(stops, 0);

  window.emit("closed");
  window.emit("closed");
  assert.equal(stops, 1);
});

test("初始化期间关闭窗口，初始化完成后不请求模型", async () => {
  const window = new EventEmitter();
  const initializing = Promise.withResolvers();
  const initialized = Promise.withResolvers();
  let sends = 0;

  const service = createChatService(
    {
      getSession() {
        initializing.resolve();
        return initialized.promise;
      },
    },
    async () => async () => {
      sends += 1;
    },
  );

  registerWindowLifecycle(window, service);

  const pending = service.send("测试", () => {}, () => {});

  await initializing.promise;
  window.emit("closed");
  initialized.resolve({});

  assert.deepEqual(await pending, { stopped: true });
  assert.equal(sends, 0);
  assert.equal(service.isBusy(), false);
});

test("生成期间关闭会停止请求，结束后允许再次发送", async () => {
  const window = new EventEmitter();
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const received = [];
  let aborts = 0;
  let sends = 0;

  const session = {
    async abort() {
      aborts += 1;
      finished.resolve();
    },
  };

  const service = createChatService(
    { getSession: async () => session },
    async () =>
      async (_session, _text, onText, onTool, onStatus) => {
        sends += 1;

        if (sends > 1) {
          onText("新窗口回复");
          return;
        }

        started.resolve();
        await finished.promise;

        // 模拟取消后仍到达的事件，服务应全部忽略。
        onText("关闭后的文本");
        onTool({ type: "end", name: "test" });
        onStatus("关闭后的状态");
      },
  );

  registerWindowLifecycle(window, service);

  const capture = (event) => received.push(event);
  const pending = service.send(
    "测试",
    capture,
    capture,
    capture,
  );

  await started.promise;
  window.emit("closed");

  assert.deepEqual(await pending, { stopped: true });
  assert.equal(aborts, 1);
  assert.deepEqual(received, []);
  assert.equal(service.isBusy(), false);

  // 原请求结束后，原进程可以为重新打开的窗口继续服务。
  const result = await service.send(
    "继续",
    capture,
    capture,
    capture,
  );

  assert.deepEqual(result, { stopped: false });
  assert.deepEqual(received, ["新窗口回复"]);
});

test("停止失败被接住，控制台只记录固定提示", async (t) => {
  const window = new EventEmitter();
  const reported = Promise.withResolvers();

  const log = t.mock.method(console, "error", (...args) => {
    reported.resolve(args);
  });

  registerWindowLifecycle(window, {
    async stop() {
      throw new Error("不应输出的原始错误");
    },
  });

  window.emit("closed");

  assert.deepEqual(await reported.promise, [
    "窗口已关闭，但停止生成未确认成功。",
  ]);
  assert.equal(log.mock.callCount(), 1);
});