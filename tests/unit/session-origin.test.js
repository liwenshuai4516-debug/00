const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const runFile = promisify(execFile);

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-origin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const other = path.join(root, "other");
  await fs.mkdir(workspace);
  await fs.mkdir(other);
  const { createWorkspaceSession } = await import(
    "../../src/main/workspace/workspace-session.mjs"
  );
  return {
    root, workspace, other, createWorkspaceSession,
    sessionDir: path.join(root, "sessions"),
  };
}

function persist(manager) {
  // Pi 1.4 从真实用户消息开始写历史；测试只追加本地数据，不请求模型。
  manager.appendMessage({ role: "user", content: "来源测试", timestamp: Date.now() });
}

test("新建与无匹配历史的自动恢复均标记 empty，不制造聊天记录", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession } = await setup(t);
  for (const resume of [false, true]) {
    const result = await createWorkspaceSession({
      sessionDir, workspaceDir: workspace, resume,
    });
    assert.equal(result.source, "empty");
    assert.deepEqual(result.sessionManager.buildSessionContext().messages, []);
    await assert.rejects(fs.stat(result.sessionManager.getSessionFile()), { code: "ENOENT" });
  }
});

test("显式打开历史标记 history，原文件后来丢失也不降级", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession } = await setup(t);
  const original = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(original.sessionManager);
  const sessionPath = original.sessionManager.getSessionFile();
  const opened = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath });
  assert.equal(opened.source, "history");
  assert.equal(opened.sessionManager.getSessionId(), original.sessionManager.getSessionId());
  await fs.rm(sessionPath);
  assert.equal(opened.source, "history");
  // 明确指定丢失历史仍必须报错，不能改为创建空会话。
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath }),
    { code: "ENOENT" },
  );
});

test("自动恢复的合法历史为 history，其他目录无历史仍为 empty", async (t) => {
  const { workspace, other, sessionDir, createWorkspaceSession } = await setup(t);
  const original = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(original.sessionManager);
  const restored = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true });
  assert.equal(restored.source, "history");
  assert.equal(restored.sessionManager.getSessionId(), original.sessionManager.getSessionId());
  const created = await createWorkspaceSession({ sessionDir, workspaceDir: other, resume: true });
  assert.equal(created.source, "empty");
  assert.notEqual(created.sessionManager.getSessionId(), original.sessionManager.getSessionId());
});

test("真实 Pi 会话保留来源与实际模型，初始化和恢复都不请求模型", async (t) => {
  const { root, workspace, sessionDir } = await setup(t);
  const agentUrl = pathToFileURL(require.resolve("../../src/main/pi-agent.mjs")).href;
  const script = `
    const assert = require("node:assert/strict");
    const { existsSync } = require("node:fs");
    globalThis.fetch = async () => assert.fail("测试不能访问网络或模型");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(agentUrl)});
      const [sessionDir, workspace] = process.argv.slice(1);
      const first = await createPiAgent(sessionDir, false, undefined, workspace);
      let id;
      let file;
      try {
        assert.equal(first.desktopSessionOrigin, "empty");
        assert.equal(existsSync(first.sessionFile), false);
        assert.deepEqual(first.messages, []);
        // 切换只有模型元数据，不应制造聊天历史或改变初始来源。
        const pro = first.modelRuntime.getModel("deepseek", "deepseek-v4-pro");
        assert.ok(pro);
        await first.setModel(pro, { persist: false });
        assert.equal(first.model.id, "deepseek-v4-pro");
        assert.equal(first.desktopSessionOrigin, "empty");
        assert.equal(existsSync(first.sessionFile), false);
        id = first.sessionId;
        file = first.sessionFile;
        first.sessionManager.appendMessage({
          role: "user", content: "临时来源测试", timestamp: Date.now(),
        });
        assert.equal(existsSync(file), true);
      } finally {
        first.dispose();
      }
      const opened = await createPiAgent(sessionDir, false, file, workspace);
      try {
        assert.equal(opened.desktopSessionOrigin, "history");
        assert.equal(opened.sessionId, id);
        assert.equal(opened.model.id, "deepseek-v4-pro");
      } finally {
        opened.dispose();
      }
      const resumed = await createPiAgent(sessionDir, true, undefined, workspace);
      try {
        assert.equal(resumed.desktopSessionOrigin, "history");
        assert.equal(resumed.sessionId, id);
      } finally {
        resumed.dispose();
      }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runFile(process.execPath, ["-e", script, sessionDir, workspace], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(root, "pi-config"),
      PI_OFFLINE: "1",
      PI_PROVIDER: "deepseek",
      PI_MODEL: "deepseek-flash",
      PI_BASE_URL: "https://example.invalid/v1",
      DEEPSEEK_API_KEY: "test-only-placeholder",
      AGENT_WORKSPACE_DIR: workspace,
    },
    encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});