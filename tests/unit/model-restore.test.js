const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { mkdtemp, mkdir, rm } = require("node:fs/promises");
const runFile = promisify(execFile);

test("真实 Pi 会话恢复各自模型、遵循分支并拒绝无效记录", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-model-restore-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const servicePath = require.resolve(
    "../../src/main/services/session-service.js"
  );
  const script = `
    const assert = require("node:assert/strict");
    const { readFile } = require("node:fs/promises");
    const { createSessionService } = require(${JSON.stringify(servicePath)});

    // 任何意外网络请求都应令测试失败。
    globalThis.fetch = async () => assert.fail("测试不能访问网络");

    async function check() {
      const dir = process.argv[1];
      const service = createSessionService(dir);
      const first = await service.getSession();
      assert.equal(first.model.id, "deepseek-flash");
      const id = first.sessionId;
      const file = first.sessionFile;

      // 直接写入测试消息以持久化会话，不调用 prompt。
      first.sessionManager.appendMessage({
        role: "user", content: "测试消息", timestamp: Date.now(),
      });
      await service.switchModel("deepseek-v4-pro");
      first.dispose();

      // 新服务模拟重新打开应用，通过实际历史列表打开原会话。
      const reopenedService = createSessionService(dir);
      await reopenedService.openSession(id);
      const reopened = await reopenedService.getSession();
      assert.equal(reopened.model.id, "deepseek-v4-pro");
      assert.equal(reopened.model.baseUrl, "https://example.invalid/v1");
      reopened.dispose();

      // 自动恢复也应采用该会话记录，而不是 .env 默认模型。
      const resumed = await createSessionService(dir).getSession(true);
      assert.equal(resumed.sessionId, id);
      assert.equal(resumed.model.id, "deepseek-v4-pro");

      // 新会话继续使用默认模型，不继承上一会话的选择。
      const fresh = await createSessionService(dir).getSession();
      assert.equal(fresh.model.id, "deepseek-flash");
      assert.notEqual(fresh.sessionId, id);
      fresh.dispose();

      // 建立另一分支，最新文件记录不等于当前分支的模型选择。
      const manager = resumed.sessionManager;
      const branchPoint = manager.getBranch().find(
        entry => entry.type === "model_change"
      ).id;
      manager.appendModelChange("deepseek", "deepseek-v4-pro");
      manager.branch(branchPoint);
      manager.appendMessage({
        role: "user", content: "另一分支", timestamp: Date.now(),
      });
      resumed.dispose();

      const branchedService = createSessionService(dir);
      await branchedService.openSession(id);
      const branched = await branchedService.getSession();
      assert.equal(branched.model.id, "deepseek-flash");
      branched.dispose();

      // 未登记模型与跨供应商记录必须明确拒绝，不能静默回退。
      for (const [provider, modelId, error] of [
        ["deepseek", "missing-model", /Pi 未找到模型/],
        ["unknown-provider", "gpt-4", /Pi 未找到模型/],
      ]) {
        manager.appendModelChange(provider, modelId);
        const before = await readFile(file, "utf8");
        await assert.rejects(
          createSessionService(dir).openSession(id),
          error,
        );
        assert.equal(await readFile(file, "utf8"), before);
      }
    }
    check().catch(error => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  await runFile(
    process.execPath,
    ["-e", script, path.join(base, "sessions")],
    {
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: path.join(base, "pi-config"),
        PI_OFFLINE: "1",
        PI_PROVIDER: "deepseek",
        PI_MODEL: "deepseek-flash",
        PI_BASE_URL: "https://example.invalid/v1",
        DEEPSEEK_API_KEY: "test-only-not-a-real-key",
        AGENT_WORKSPACE_DIR: workspace,
      },
      encoding: "utf8",
    },
  );
});