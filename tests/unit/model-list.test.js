const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");

test("读取当前供应商模型目录，只返回页面需要的字段", async () => {
  const catalog = [
    {
      id: "deepseek-flash",
      name: "DeepSeek Flash",
      baseUrl: "https://example.invalid",
      internalData: "不返回页面",
    },
    { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
  ];
  let creations = 0;
  const session = {
    model: { provider: "deepseek", id: "deepseek-flash" },
    modelRuntime: {
      getModels(provider) {
        assert.equal(provider, "deepseek");
        return catalog;
      },
    },
    async prompt() {
      assert.fail("读取目录不能请求模型");
    },
  };
  const service = createSessionService("unused", async () => {
    creations += 1;
    return session;
  });
  const expected = {
    provider: "deepseek",
    modelId: "deepseek-flash",
    models: [
      { id: "deepseek-flash", name: "DeepSeek Flash" },
      { id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
    ],
  };

  const result = await service.listModels();
  assert.deepEqual(result, expected);

  // 页面修改返回值，不能影响 SDK 目录或当前选择。
  result.models[0].name = "被页面修改";
  result.models.pop();
  assert.deepEqual(await service.listModels(), expected);
  assert.equal(session.model.id, "deepseek-flash");
  assert.equal(creations, 1);
});

test("当前会话没有模型时返回明确错误", async () => {
  const service = createSessionService("unused", async () => ({
    model: undefined,
    modelRuntime: {
      getModels() {
        assert.fail("没有当前模型时不能读取目录");
      },
    },
  }));

  await assert.rejects(service.listModels(), {
    message: "当前会话尚未选择模型。",
  });
});
test("模型列表 IPC 不转发页面指定的供应商或会话", async () => {
  const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
  const handlers = new Map();
  const expected = {
    provider: "deepseek",
    modelId: "deepseek-flash",
    models: [{ id: "deepseek-flash", name: "DeepSeek Flash" }],
  };
  let calls = 0;

  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      async listModels(...args) {
        assert.deepEqual(args, []);
        calls += 1;
        return expected;
      },
    },
    { isBusy: () => true },
  );

  // 读取目录不会切换模型，生成期间也可读取。
  const result = await handlers.get("agent:list-models")(
    {},
    "other-provider",
    "other-session",
  );

  assert.deepEqual(result, expected);
  assert.equal(calls, 1);
});
