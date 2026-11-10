const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);

test("真实 SDK 中新旧会话、空会话恢复和旧历史采用正确提示词，不请求模型", async (t) => {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "session-prompt-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "workspace"));
  await fs.mkdir(path.join(root, "pi-config"), { recursive: true });
  await fs.writeFile(path.join(root, "pi-config/SYSTEM.md"), "全局自定义系统规则夹具");
  await fs.writeFile(path.join(root, "pi-config/APPEND_SYSTEM.md"), "全局追加规则夹具");
  await fs.writeFile(path.join(root, "workspace/AGENTS.md"), "项目上下文夹具");
  await fs.mkdir(path.join(root, "workspace/.pi/skills/prompt-fixture"), { recursive: true });
  await fs.writeFile(path.join(root, "workspace/.pi/SYSTEM.md"), "项目自定义系统规则夹具");
  await fs.writeFile(path.join(root, "workspace/.pi/APPEND_SYSTEM.md"), "项目追加规则夹具");
  await fs.writeFile(path.join(root, "workspace/.pi/skills/prompt-fixture/SKILL.md"), "---\nname: prompt-fixture\ndescription: 提示词加载夹具\n---\n\n只用于离线检查。\n");
  const piPath = path.resolve(__dirname, "../../src/main/pi-agent.mjs");
  const storePath = require.resolve("../../src/main/storage/prompt-settings-store.js");
  const statePath = require.resolve("../../src/main/storage/session-state-store.js");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const { pathToFileURL } = require("node:url");
    const { createPromptSettingsStore } = require(${JSON.stringify(storePath)});
    const { createSessionStateStore } = require(${JSON.stringify(statePath)});
    async function main() {
      const { createPiAgent } = await import(pathToFileURL(${JSON.stringify(piPath)}).href);
      const base = process.argv[1];
      const workspace = path.join(base, "workspace");
      const sessions = path.join(base, "sessions");
      const prompts = createPromptSettingsStore(path.join(base, "prompt.json"), async () => "职责 A");
      const states = createSessionStateStore(path.join(base, "state"));
      const model = { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1" };
      const options = { promptSettingsStore: prompts, sessionStateStore: states };
      const create = (sessionPath, recovery) => createPiAgent(
        sessions, false, sessionPath, workspace, model, recovery, undefined, options,
        { askProjectTrust: async () => ({ trusted: true }) },
      );

      const first = await create();
      let firstPath;
      try {
        assert.ok(first.systemPrompt.includes("职责 A"));
        assert.ok(first.systemPrompt.startsWith("职责 A"), "配置正文必须成为系统提示词主体");
        assert.ok(!first.systemPrompt.includes("You are an expert coding assistant operating inside pi"));
        assert.ok(first.systemPrompt.includes("Pi 原生语义"));
        for (const marker of ["项目自定义系统规则夹具", "项目追加规则夹具", "项目上下文夹具", "prompt-fixture"]) {
          assert.ok(first.systemPrompt.includes(marker), marker);
        }
        assert.ok(!first.systemPrompt.includes("全局自定义系统规则夹具"), "项目 SYSTEM.md 保留官方发现优先级");
        assert.ok(!first.systemPrompt.includes("全局追加规则夹具"), "项目 APPEND_SYSTEM.md 保留官方发现优先级");
        assert.deepEqual(first.getActiveToolNames().sort(), ["read", "bash", "edit", "write", "todo_write", "subagent", "subagent_fork", "send_message", "list_agents", "interrupt_agent"].sort());
        // 只写临时本地历史，使 SDK 产生可恢复文件。
        first.sessionManager.appendMessage({ role: "user", content: "临时历史", timestamp: Date.now() });
        firstPath = first.sessionFile;
      } finally { first.dispose(); }
      await prompts.save("职责 B", 0);

      const reopened = await create(firstPath);
      try {
        assert.equal(reopened.desktopPromptSnapshot.testAgentPrompt, "职责 A");
        assert.ok(reopened.systemPrompt.includes("职责 A"));
        assert.ok(reopened.systemPrompt.startsWith("职责 A"));
      } finally { reopened.dispose(); }

      const empty = await create();
      const emptyId = empty.sessionId;
      try {
        assert.equal(empty.desktopPromptSnapshot.testAgentPrompt, "职责 B");
        await states.registerSession(emptyId, workspace, "empty", { provider: "openai", modelId: "gpt-4" });
        await states.saveDraft(emptyId, workspace, "未发送输入", 0);
      } finally { empty.dispose(); }
      await prompts.save("职责 C", 1);
      const restored = await create(undefined, await states.load(emptyId));
      try {
        assert.equal(restored.sessionId, emptyId);
        assert.equal(restored.desktopPromptSnapshot.testAgentPrompt, "职责 B");
        assert.ok(restored.systemPrompt.startsWith("职责 B"));
      } finally { restored.dispose(); }

      await states.consumeDraft(emptyId, workspace, "未发送输入", 1);
      await assert.rejects(create(undefined, await states.load(emptyId)), /待确认发送/);

      // 模拟没有应用提示词快照的旧历史，不读取用户真实会话。
      const { createWorkspaceSession } = await import(pathToFileURL(path.join(path.dirname(${JSON.stringify(piPath)}), "workspace/workspace-session.mjs")).href);
      const legacy = await createWorkspaceSession({ sessionDir: sessions, workspaceDir: workspace });
      legacy.sessionManager.appendMessage({ role: "user", content: "旧测试历史", timestamp: Date.now() });
      const adopted = await create(legacy.sessionManager.getSessionFile());
      try {
        assert.equal(adopted.desktopPromptSnapshot.origin, "legacy");
        assert.equal(adopted.desktopPromptSnapshot.testAgentPrompt, "职责 C");
      } finally { adopted.dispose(); }
    }
    main().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runFile(process.execPath, ["-e", script, root], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "pi-config") },
    encoding: "utf8",
  });
  assert.equal(result.stderr, "");
});
