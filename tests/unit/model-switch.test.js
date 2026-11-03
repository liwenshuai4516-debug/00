const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");

function setup() {
  const models = [
    { provider: "deepseek", id: "deepseek-flash" },
    { provider: "deepseek", id: "deepseek-v4-pro" },
  ];
  const calls = [];
  const session = {
    model: models[0],
    modelRuntime: {
      getModel(provider, id) {
        assert.equal(provider, "deepseek");
        return models.find((model) => model.id === id);
      },
    },
    async setModel(model, options) {
      // 模拟异步切换，服务必须等待完成再返回实际选择。
      await Promise.resolve();
      calls.push({ model, options });
      this.model = model;
    },
    async prompt() {
      assert.fail("切换模型不能发送聊天请求");
    },
  };
  const service = createSessionService("unused", async () => session);
  return { service, session, models, calls };
}

test("按当前供应商切换模型，相同选择不重复记录", async () => {
  const { service, session, models, calls } = setup();
  const expected = {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  };

  assert.deepEqual(await service.switchModel(" deepseek-v4-pro "), expected);
  assert.equal(session.model, models[1]);
  assert.deepEqual(calls, [{ model: models[1], options: { persist: false } }]);

  assert.deepEqual(await service.switchModel("deepseek-v4-pro"), expected);
  assert.equal(calls.length, 1);
});

test("无效编号在初始化会话前拒绝", async () => {
  const service = createSessionService("unused", async () => {
    assert.fail("无效输入不能触发初始化");
  });

  for (const id of [undefined, null, 42, {}, "", "  "]) {
    await assert.rejects(service.switchModel(id), /请选择模型/);
  }
});

test("拒绝未登记编号和跨供应商编号，缺少当前模型时也拒绝", async () => {
  const { service, session, models, calls } = setup();

  for (const id of ["unknown", "openai/gpt-4"]) {
    await assert.rejects(service.switchModel(id), /Pi 未登记/);
  }

  assert.equal(session.model, models[0]);
  assert.deepEqual(calls, []);

  session.model = undefined;
  await assert.rejects(
    service.switchModel("deepseek-v4-pro"),
    /请选择供应商和模型/,
  );
});

test("SDK 切换失败时透传错误", async () => {
  const { service, session } = setup();
  session.setModel = async () => {
    throw new Error("模拟凭据检查失败");
  };

  await assert.rejects(
    service.switchModel("deepseek-v4-pro"),
    /模拟凭据检查失败/,
  );
});

test("生成期间拒绝切换，空闲时只转发模型编号", async () => {
  const { registerAgentIpc } = require(
    "../../src/main/ipc/agent-ipc.js"
  );
  const handlers = new Map();
  const calls = [];
  let busy = true;
  const expected = {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  };

  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      async switchModel(...args) {
        calls.push(args);
        return expected;
      },
    },
    { isBusy: () => busy },
  );

  const handler = handlers.get("agent:switch-model");
  assert.throws(
    () => handler({}, "deepseek-v4-pro"),
    /请等待当前回复结束/,
  );
  assert.deepEqual(calls, []);

  busy = false;
  assert.deepEqual(
    await handler(
      {},
      "deepseek-v4-pro",
      "deepseek",
      "other-session",
    ),
    expected,
  );
  assert.deepEqual(calls, [["deepseek-v4-pro", "deepseek"]]);
});

test("切换期间阻止冲突操作，失败后释放互斥状态", async () => {
  const { registerAgentIpc } = require(
    "../../src/main/ipc/agent-ipc.js"
  );
  const handlers = new Map();
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let switches = 0;

  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      switchModel() {
        switches += 1;

        if (switches === 1) {
          started.resolve();
          return finished.promise;
        }

        return {
          provider: "deepseek",
          modelId: "deepseek-v4-pro",
        };
      },
    },
    { isBusy: () => false },
  );

  const handler = handlers.get("agent:switch-model");
  const pending = handler({}, "deepseek-v4-pro");
  await started.promise;

  for (const channel of [
    "agent:switch-model",
    "agent:new-chat",
    "agent:open-session",
    "agent:rename-session",
    "agent:compact-session",
    "agent:export-conversation",
    "agent:get-proposal",
    "agent:apply-proposal",
    "agent:discard-proposal",
  ]) {
    assert.throws(
      () => handlers.get(channel)({}, "value"),
      /其他操作完成/,
    );
  }

  assert.throws(
    () => handlers.get("agent:send-message")({}, "你好"),
    /当前操作结束/,
  );
  assert.equal(switches, 1);

  // 先建立拒绝断言，再模拟失败，避免未处理的 Promise 拒绝。
  const rejected = assert.rejects(pending, /模拟切换失败/);
  finished.reject(new Error("模拟切换失败"));
  await rejected;

  assert.deepEqual(await handler({}, "deepseek-v4-pro"), {
    provider: "deepseek",
    modelId: "deepseek-v4-pro",
  });
  assert.equal(switches, 2);
});