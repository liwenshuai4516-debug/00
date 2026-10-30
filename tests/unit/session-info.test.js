const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, rm } = require("node:fs/promises");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

function makeSession(id, workspaceDir, modelId) {
  return {
    sessionId: id,
    sessionManager: { getCwd: () => workspaceDir },
    model: {
      provider: "test-provider",
      id: modelId,
      apiKey: "fake-secret",
      baseUrl: "https://example.invalid",
    },
    sessionFile: "/private/session.jsonl",
    messages: [],
    // 默认模拟 SDK 暂时没有上下文估算。
    getContextUsage: () => undefined,
    dispose() {},
  };
}

test("信息来自真实会话对象，返回字段不包含密钥或完整 SDK 对象", async () => {
  const session = makeSession("session-a", "/actual-workspace", "actual-model");
  const service = createSessionService("unused", async () => session);

  assert.deepEqual(await service.getSessionInfo(), {
    sessionId: "session-a",
    workspaceDir: "/actual-workspace",
    provider: "test-provider",
    modelId: "actual-model",
    contextUsage: null,
  });
});

test("新建成功后信息跟随新会话", async () => {
  const sessions = [
    makeSession("first", "/workspace-a", "model-a"),
    makeSession("next", "/workspace-b", "model-b"),
  ];

  const service = createSessionService(
    "unused",
    async () => sessions.shift(),
  );

  // 先初始化旧会话，再验证新建后信息切换到新会话。
  assert.equal(
    (await service.getSessionInfo()).sessionId,
    "first",
  );

  await service.newChat();

  assert.deepEqual(await service.getSessionInfo(), {
    sessionId: "next",
    workspaceDir: "/workspace-b",
    provider: "test-provider",
    modelId: "model-b",
    contextUsage: null,
  });
});

test("新建失败后仍返回原会话信息", async () => {
  let calls = 0;
  const session = makeSession("original", "/workspace", "model-a");
  const service = createSessionService("unused", async () => {
    if (++calls === 1) return session;
    throw new Error("新建失败");
  });
  const before = await service.getSessionInfo();
  await assert.rejects(service.newChat(), /新建失败/);
  assert.deepEqual(await service.getSessionInfo(), before);
});

test("打开历史成功后，信息来自已切换的实际会话", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-session-info-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "saved.jsonl");
  const timestamp = new Date().toISOString();
  // 只创建测试用会话列表数据，不读取用户历史或请求模型。
  const entries = [
    { type: "session", version: 3, id: "saved", timestamp, cwd: "/workspace" },
    {
      type: "message",
      id: "u1",
      parentId: null,
      timestamp,
      message: { role: "user", content: "测试历史", timestamp: Date.now() },
    },
  ];
  await writeFile(
    file,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  const first = makeSession("first", "/workspace", "model-a");
  const selected = makeSession("saved", "/workspace", "model-b");
  const service = createSessionService(
    dir,
    async (_dir, _resume, sessionPath) => {
      if (sessionPath) {
        assert.equal(sessionPath, file);
        return selected;
      }
      return first;
    },
  );
  await service.getSessionInfo();
  await service.openSession("saved");
  assert.equal((await service.getSessionInfo()).sessionId, "saved");
  assert.equal((await service.getSessionInfo()).modelId, "model-b");
});

test("信息 IPC 不接受页面指定的其他会话编号", async () => {
  const handlers = new Map();
  const expected = {
    sessionId: "current",
    workspaceDir: "/workspace",
    provider: "test",
    modelId: "model",
  };
  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      async getSessionInfo(...args) {
        assert.deepEqual(args, []);
        return expected;
      },
    },
    { isBusy: () => false },
  );
  assert.deepEqual(
    await handlers.get("agent:session-info")({}, "other-session"),
    expected,
  );
});

test("只返回上下文估算的必要字段，并保留未知值", async () => {
  const session = makeSession("session-a", "/workspace", "model-a");

  let usage = {
    tokens: 1200,
    contextWindow: 10000,
    percent: 12,
    internalData: "不应返回页面",
  };

  session.getContextUsage = () => usage;

  const service = createSessionService("unused", async () => session);

  // 页面只应收到约定字段，额外的内部信息必须被过滤。
  assert.deepEqual((await service.getSessionInfo()).contextUsage, {
    tokens: 1200,
    contextWindow: 10000,
    percent: 12,
  });

  // 压缩后的未知值必须原样保留，不能转换为零。
  usage = {
    tokens: null,
    contextWindow: 10000,
    percent: null,
  };

  assert.deepEqual((await service.getSessionInfo()).contextUsage, usage);
});
