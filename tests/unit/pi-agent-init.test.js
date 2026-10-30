const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { mkdtemp, mkdir, rm } = require("node:fs/promises");
const runFile = promisify(execFile);

test("有效配置能初始化及新建真实 Pi 会话，不请求模型", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-init-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const servicePath =
    require.resolve("../../src/main/services/session-service.js");
  const script = `
    const assert = require("node:assert/strict");
    const { realpathSync } = require("node:fs");
    const { createSessionService } = require(${JSON.stringify(servicePath)});
    async function check() {
      const service = createSessionService(process.argv[1]);
      const first = await service.getSession(true);
      const firstId = first.sessionId;
      // 核对 Pi 1.4 的模型运行时、地址覆盖与工具权限，不请求模型。
      assert.equal(first.model.baseUrl, "https://example.invalid/v1");
      assert.equal(first.modelRuntime.getModel("openai", "gpt-4").baseUrl, first.model.baseUrl);
      assert.ok(first.getActiveToolNames().includes("read_workspace_lines"));
      assert.ok(!first.getActiveToolNames().some(name => ["read", "bash", "edit", "write"].includes(name)));
            // 核对真实 Pi 会话返回的信息，不请求模型。
     assert.deepEqual(await service.getSessionInfo(), {
      sessionId: firstId,
      workspaceDir: realpathSync(process.env.AGENT_WORKSPACE_DIR),
      provider: first.model.provider,
      modelId: first.model.id,
      contextUsage: first.getContextUsage() ?? null,
    });
      assert.equal(first.sessionManager.getCwd(), realpathSync(process.env.AGENT_WORKSPACE_DIR));
      await service.newChat();
      const next = await service.getSession();
      try {
        assert.notEqual(next.sessionId, firstId);
        assert.equal(next.sessionManager.getCwd(), realpathSync(process.env.AGENT_WORKSPACE_DIR));
        assert.ok(next.sessionManager.getEntries().some(entry =>
          entry.type === "custom" && entry.customType === "desktop-workspace-binding"
        ));
      } finally {
        next.dispose();
      }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  // 独立进程使用临时配置目录，不加载项目 .env；不调用 prompt。
  const result = await runFile(
    process.execPath,
    ["-e", script, path.join(base, "sessions")],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(base, "pi-config"),
        PI_PROVIDER: "openai",
        PI_MODEL: "gpt-4",
        PI_BASE_URL: "https://example.invalid/v1",
        AGENT_WORKSPACE_DIR: workspace,
      },
      encoding: "utf8",
    },
  );
  assert.equal(result.stderr, "");
});

test("供应商地址无效时，在创建会话目录之前拒绝初始化", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-invalid-config-"));

  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  await mkdir(workspace);

  const sessionDir = path.join(base, "sessions");
  const servicePath =
    require.resolve("../../src/main/services/session-service.js");

  const script = `
    const assert = require("node:assert/strict");
    const { existsSync } = require("node:fs");
    const { createSessionService } = require(${JSON.stringify(servicePath)});

    async function check() {
      const service = createSessionService(process.argv[1]);

      await assert.rejects(service.getSession(), {
        message: "PI_BASE_URL 必须是完整的 http:// 或 https:// 地址。",
      });

      assert.equal(existsSync(process.argv[1]), false);
    }

    check().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  // 独立进程只使用临时目录和测试配置，不加载项目 .env。
  await runFile(process.execPath, ["-e", script, sessionDir], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(base, "pi-config"),
      PI_PROVIDER: "openai",
      PI_MODEL: "gpt-4",
      PI_BASE_URL: "ftp://example.invalid",
      AGENT_WORKSPACE_DIR: workspace,
    },
    encoding: "utf8",
  });
});
