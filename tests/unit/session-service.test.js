const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");
const { execFileSync } = require("node:child_process");
// 测试只传递目录路径，不创建目录或写入文件。
const sessionDir = path.join(os.tmpdir(), "agent-session-tests");

test("重复获取会话时只初始化一次", async () => {
  let calls = 0;
  const session = { sessionId: "first" };

  const service = createSessionService(sessionDir, async () => {
    calls += 1;
    return session;
  });

  // 在第一次初始化完成前再次获取，验证共享初始化过程。
  const first = service.getSession();
  const second = service.getSession();

  assert.equal(first, second);

  const results = await Promise.all([first, second]);

  assert.equal(calls, 1);
  assert.equal(results[0], session);
  assert.equal(results[1], session);
});

test("初始化失败后可以重试", async () => {
  let calls = 0;
  const session = { sessionId: "recovered" };

  const service = createSessionService(sessionDir, async () => {
    calls += 1;

    if (calls === 1) {
      throw new Error("初始化失败");
    }

    return session;
  });

  await assert.rejects(service.getSession(), /初始化失败/);

  assert.equal(await service.getSession(), session);
  assert.equal(calls, 2);
});

test("新建会话失败时保留原会话", async () => {
  let calls = 0;
  let disposed = false;

  const previous = {
    sessionId: "previous",
    dispose() {
      disposed = true;
    },
  };

  const service = createSessionService(sessionDir, async () => {
    calls += 1;

    if (calls === 1) return previous;

    throw new Error("新建失败");
  });

  await service.getSession();
  await assert.rejects(service.newChat(), /新建失败/);

  // 失败不能导致原会话丢失或提前释放。
  assert.equal(await service.getSession(), previous);
  assert.equal(disposed, false);
});

test("新建成功后切换会话并释放原会话", async () => {
  let calls = 0;
  let disposeCalls = 0;

  const previous = {
    sessionId: "previous",
    dispose() {
      disposeCalls += 1;
    },
  };

  const next = { sessionId: "next" };

  const service = createSessionService(sessionDir, async () => {
    calls += 1;
    return calls === 1 ? previous : next;
  });

  await service.getSession();
  assert.equal(await service.newChat(), "next");

  assert.equal(await service.getSession(), next);
  assert.equal(await service.currentSession(), "next");
  assert.equal(disposeCalls, 1);
});

test("默认创建路径在缺少模型配置时返回明确错误", () => {
  const servicePath = require.resolve(
    "../../src/main/services/session-service.js",
  );

  // 使用独立进程，避免修改其他测试或当前终端的环境变量。
  const script = `
    const assert = require("node:assert/strict");
    const { createSessionService } = require(${JSON.stringify(servicePath)});

    async function check() {
      const service = createSessionService(process.argv[1]);

      await assert.rejects(service.getSession(), {
        message: "请在 .env 中配置 PI_PROVIDER 和 PI_MODEL。",
      });
    }

    check().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  // 不加载 .env，并明确清空模型配置，确保不会发送模型请求。
  execFileSync(process.execPath, ["-e", script, sessionDir], {
    env: {
      ...process.env,
      PI_PROVIDER: "",
      PI_MODEL: "",
    },
    encoding: "utf8",
  });
});

test("保存记录使用自定义消息写入同一会话，不触发生成", async () => {
  const received = [];
  const session = {
    sessionId: "session-a",
    async sendCustomMessage(message, options) {
      received.push({ message, options });
    },
    async prompt() {
      assert.fail("记录保存结果不应发起模型请求");
    },
  };
  const service = createSessionService(sessionDir, async () => session);
  const proposal = {
    id: "p-1",
    sessionId: "session-a",
    path: "example.js",
    oldText: "before",
    newText: "after",
  };

  await service.recordWorkspaceEdit(proposal);

  assert.equal(received.length, 1);
  const { message, options } = received[0];
  assert.equal(message.customType, "workspace-edit-applied");
  assert.equal(message.display, true);
  assert.deepEqual(message.details, {
    proposalId: "p-1", path: "example.js",
  });
  assert.deepEqual(options, { triggerTurn: false });
  assert.match(message.content, /"oldText":"before"/);
  assert.match(message.content, /"newText":"after"/);
  assert.match(message.content, /继续修改前请重新读取文件/);
});

test("会话归属不匹配时拒绝写入保存记录", async () => {
  let calls = 0;
  const service = createSessionService(sessionDir, async () => ({
    sessionId: "session-b",
    async sendCustomMessage() { calls += 1; },
  }));

  await assert.rejects(
    service.recordWorkspaceEdit({ sessionId: "session-a" }),
    /会话已变化/,
  );
  assert.equal(calls, 0);
});
