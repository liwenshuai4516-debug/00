import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import { createPiResources } from "../../src/main/resources/pi-resources.mjs";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";
import { ProjectTrustStore } from "@mariozechner/pi-coding-agent";

const [base, scenario] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const repo = path.join(base, "repo");
const workspace = path.join(repo, "app");
const diagnostics = [];
const config = { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "offline-test-only" };
const skill = (name, body = "SKILL_BODY_MARKER") => `---\nname: ${name}\ndescription: 测试技能 ${name}\n---\n${body}`;
async function put(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, value);
}
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
await put(path.join(repo, ".git"), "gitdir: unused-test-only\n");
const create = (options = {}) => createPiAgent(
  path.join(base, "sessions"), false, undefined, workspace, config,
  undefined, undefined, undefined,
  { onDiagnostics: async items => diagnostics.push(...items), ...options },
);

if (scenario === "resources") {
  // 复制仓库实际技能，核对迁移后的路径及信任行为；不改工作区资源。
  await fs.cp(new URL("../../.pi/skills/", import.meta.url), path.join(workspace, ".pi", "skills"), { recursive: true });
  await put(path.join(agentDir, "skills", "standalone.md"), skill("standalone"));
  const linked = path.join(base, "linked-skill");
  await put(path.join(linked, "SKILL.md"), skill("linked"));
  await put(path.join(linked, "assets", "data.json"), '{"ok":true}');
  await fs.symlink(linked, path.join(agentDir, "skills", "linked"));
  await put(path.join(workspace, ".pi", "skills", "project", "SKILL.md"), skill("project"));
  await put(path.join(repo, ".agents", "skills", "ancestor", "SKILL.md"), skill("ancestor"));
  await put(path.join(base, ".agents", "skills", "outside-repo", "SKILL.md"), skill("outside-repo"));
  await put(path.join(agentDir, "skills", "warning", "SKILL.md"), skill("InvalidName"));
  await put(path.join(agentDir, "skills", "collision", "SKILL.md"), skill("collision", "USER_COLLISION"));
  await put(path.join(workspace, ".pi", "skills", "collision", "SKILL.md"), skill("collision", "PROJECT_COLLISION"));
  await put(path.join(agentDir, "skills", "missing", "SKILL.md"), "---\nname: missing\n---\nno description");
  await put(path.join(agentDir, "APPEND_SYSTEM.md"), "GLOBAL_APPEND");
  await put(path.join(workspace, ".pi", "APPEND_SYSTEM.md"), "PROJECT_APPEND");
  await put(path.join(workspace, ".pi", "SYSTEM.md"), "PROJECT_SYSTEM");
  await put(path.join(workspace, "AGENTS.md"), "PROJECT_CONTEXT");
  await put(path.join(workspace, ".pi", "prompts", "review.md"), "---\ndescription: 测试模板\n---\nREVIEW $1 $@");
  const pkg = path.join(base, "package");
  await put(path.join(pkg, "package.json"), JSON.stringify({ name: "native-test-package", version: "1.0.0", pi: { skills: ["skills"] } }));
  await put(path.join(pkg, "skills", "packaged", "SKILL.md"), skill("packaged"));
  const plainPackage = path.join(base, "plain-package");
  await put(path.join(plainPackage, "package.json"), JSON.stringify({ name: "plain-package", version: "1.0.0" }));
  await put(path.join(plainPackage, "skills", "plain-packaged", "SKILL.md"), skill("plain-packaged"));
  await put(path.join(agentDir, "settings.json"), JSON.stringify({ packages: [pkg, plainPackage] }));
  for (const trusted of [false, true]) {
    const session = await create({ askProjectTrust: async () => ({ trusted }) });
    try {
      const prompt = session.systemPrompt;
      for (const name of ["standalone", "linked", "packaged", "plain-packaged", "InvalidName"]) {
        assert.ok(prompt.includes(`<name>${name}</name>`), name);
      }
      assert.ok(!prompt.includes("<name>missing</name>"));
      assert.ok(!prompt.includes("<name>outside-repo</name>"));
      assert.equal(prompt.includes("<name>project</name>"), trusted);
      assert.equal(prompt.includes("<name>ancestor</name>"), trusted);
      for (const name of ["qa-case-design", "qa-requirement-review", "qa-skill-smoke"]) {
        assert.equal(session.resourceLoader.getSkills().skills.filter(item => item.name === name).length, trusted ? 1 : 0);
        assert.equal(prompt.includes(`<name>${name}</name>`), trusted && name !== "qa-skill-smoke");
      }
      assert.ok(prompt.includes("PROJECT_CONTEXT"));
      assert.equal(prompt.includes("PROJECT_SYSTEM"), trusted);
      assert.equal(prompt.includes("PROJECT_APPEND"), trusted);
      assert.equal(prompt.includes("GLOBAL_APPEND"), !trusted);
      assert.ok(!prompt.includes("SKILL_BODY_MARKER"));
      const tools = session.agent.state.tools;
      // 桌面会话总是追加 todo_write；其余仍由 Pi 的默认工具选择决定。
      assert.deepEqual(session.getActiveToolNames(), ["read", "bash", "edit", "write", "todo_write"]);
      const read = tools.find(t => t.name === "read");
      const result = await read.execute("read", { path: path.join(linked, "assets", "data.json") });
      assert.match(JSON.stringify(result.content), /ok/);
      await put(path.join(linked, "assets", "large.txt"), "x".repeat(40 * 1024));
      await read.execute("large", { path: path.join(linked, "assets", "large.txt") });
      await tools.find(t => t.name === "write").execute("write", { path: "created.txt", content: "before" });
      await tools.find(t => t.name === "edit").execute("edit", { path: "created.txt", edits: [{ oldText: "before", newText: "after" }] });
      assert.equal(await fs.readFile(path.join(workspace, "created.txt"), "utf8"), "after");
      const bash = await tools.find(t => t.name === "bash").execute("bash", { command: "printf PI_NATIVE_BASH_OK" });
      assert.match(JSON.stringify(bash.content), /PI_NATIVE_BASH_OK/);
      let captured;
      session.agent.prompt = async messages => { captured = messages; };
      session.agent.continue = async () => { throw new Error("不应请求模型"); };
      await session.prompt("/skill:standalone ARG_MARKER");
      assert.match(JSON.stringify(captured), /SKILL_BODY_MARKER/);
      assert.match(JSON.stringify(captured), /ARG_MARKER/);
      await session.prompt("/skill:collision");
      assert.match(JSON.stringify(captured), trusted ? /PROJECT_COLLISION/ : /USER_COLLISION/);
      if (trusted) {
        for (const [name, marker] of [["qa-case-design", "case-format.md"], ["qa-requirement-review", "checklist.md"], ["qa-skill-smoke", "PI_SKILL_SMOKE_OK"]]) {
          await session.prompt(`/skill:${name} PROJECT_SKILL_ARGUMENT`);
          assert.ok(JSON.stringify(captured).includes(marker));
          assert.match(JSON.stringify(captured), /PROJECT_SKILL_ARGUMENT/);
        }
        for (const [name, file, marker] of [["qa-case-design", "case-format.md", "来源"], ["qa-requirement-review", "checklist.md", "边界值"]]) {
          const result = await read.execute(name, { path: path.join(workspace, ".pi", "skills", name, "references", file) });
          assert.ok(JSON.stringify(result.content).includes(marker));
        }
        await fs.appendFile(path.join(workspace, ".pi/skills/qa-case-design/SKILL.md"), "\nPROJECT_SKILL_RELOADED\n");
        await session.desktopReloadResources();
        await session.prompt("/skill:qa-case-design");
        assert.match(JSON.stringify(captured), /PROJECT_SKILL_RELOADED/);
        await session.prompt("/review one two");
        assert.match(JSON.stringify(captured), /REVIEW one one two/);
      }
    } finally { await lifecycle.closePiSession(session); }
  }
  assert.ok(diagnostics.some(d => d.type === "collision"));
  assert.ok(diagnostics.some(d => d.path?.includes("warning")));
  assert.ok(diagnostics.some(d => d.path?.includes("missing")));
}

if (scenario === "trust") {
  await put(path.join(workspace, ".pi", "skills", "approved", "SKILL.md"), skill("approved"));
  await put(path.join(agentDir, "extensions", "trust.js"), `
    export default function(pi) {
      pi.on("project_trust", () => ({ trusted: "yes", remember: true }));
    }
  `);
  new ProjectTrustStore(agentDir).set(workspace, false);
  let asks = 0;
  const session = await create({ askProjectTrust: async () => { asks++; return { trusted: false }; } });
  try {
    assert.ok(session.systemPrompt.includes("<name>approved</name>"));
    assert.equal(asks, 0);
    assert.equal(new ProjectTrustStore(agentDir).get(workspace), true);
  } finally { await lifecycle.closePiSession(session); }
  await fs.unlink(path.join(agentDir, "extensions", "trust.js"));
  new ProjectTrustStore(agentDir).set(workspace, null);
  await put(path.join(agentDir, "settings.json"), '{"defaultProjectTrust":"never"}');
  const denied = await create({ askProjectTrust: async () => { throw new Error("不应询问"); } });
  try { assert.ok(!denied.systemPrompt.includes("<name>approved</name>")); }
  finally { await lifecycle.closePiSession(denied); }
}

if (scenario === "lifecycle") {
  const marker = path.join(base, "events.txt");
  await put(path.join(agentDir, "extensions", "lifecycle.js"), `
    import { appendFileSync } from "node:fs";
    import { defineTool } from "@earendil-works/pi-coding-agent";
    import { Type } from "typebox";
    export default function(pi) {
      pi.on("session_start", () => appendFileSync(${JSON.stringify(marker)}, "start\\n"));
      pi.on("session_shutdown", event => appendFileSync(${JSON.stringify(marker)}, "stop:" + event.reason + "\\n"));
      pi.registerTool(defineTool({ name: "native_fixture", label: "测试", description: "测试", parameters: Type.Object({}),
        execute: async () => ({ content: [{ type: "text", text: "EXTENSION_TOOL_OK" }], details: {} }) }));
      pi.registerCommand("fixture", { description: "测试命令", handler: async () => appendFileSync(${JSON.stringify(marker)}, "command\\n") });
    }
  `);
  const session = await create();
  try {
    assert.ok(session.getActiveToolNames().includes("native_fixture"));
    assert.ok(session.getAllTools().some(t => t.name === "codemode"));
    assert.ok(session.getAllTools().some(t => t.name === "tool_search"));
    session.agent.state.errorMessage = "旧模型错误";
    await sendMessage(session, "/fixture", () => {}, () => {});
    assert.match(await fs.readFile(marker, "utf8"), /command/);
    await sendMessage(session, "/reload", () => {}, () => {});
  } finally { await lifecycle.closePiSession(session); }
  const events = (await fs.readFile(marker, "utf8")).trim().split("\n");
  assert.deepEqual(events, ["start", "command", "stop:reload", "start", "stop:quit"]);
}

if (scenario === "settings") {
  await put(path.join(agentDir, "settings.json"), JSON.stringify({ defaultTools: ["read"], retry: { enabled: false } }));
  const session = await create();
  try {
    // defaultTools 约束原生工具；桌面的 todo_write 由 customTools 追加。
    assert.deepEqual(session.getActiveToolNames(), ["read", "todo_write"]);
    assert.equal(session.settingsManager.getRetrySettings().enabled, false);
  } finally { await lifecycle.closePiSession(session); }
  await put(path.join(agentDir, "settings.json"), "broken json");
  const resources = await createPiResources({ cwd: workspace });
  const result = await resources.reportDiagnostics();
  assert.ok(result.some(d => d.message.includes("settings")));
}

if (scenario === "mcp") {
  const server = path.join(base, "mcp-server.cjs");
  const pidFile = path.join(base, "server.pid");
  await put(server, `
    require("node:fs").writeFileSync(${JSON.stringify(pidFile)}, String(process.pid));
    const input = require("node:readline").createInterface({ input: process.stdin });
    input.on("line", line => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      let result = {};
      if (message.method === "initialize") result = {
        protocolVersion: message.params.protocolVersion,
        capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1.0.0" }
      };
      if (message.method === "tools/list") result = { tools: [
        { name: "ping", description: "本地夹具", inputSchema: { type: "object", properties: {} } }
      ] };
      if (message.method === "tools/call") result = { content: [{ type: "text", text: "MCP_FIXTURE_OK" }] };
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\\n");
    });
    input.on("close", () => process.exit(0));
  `);
  await put(path.join(agentDir, "mcp.json"), JSON.stringify({ mcpServers: {
    fixture: { command: process.execPath, args: [server], exposure: "direct" }
  } }));
  const session = await create();
  const wait = () => new Promise(resolve => setTimeout(resolve, 20));
  let pid;
  try {
    for (let attempt = 0; attempt < 100 && !session.getActiveToolNames().includes("mcp__fixture__ping"); attempt++) await wait();
    assert.ok(session.getActiveToolNames().includes("mcp__fixture__ping"), JSON.stringify(diagnostics));
    const tool = session.agent.state.tools.find(t => t.name === "mcp__fixture__ping");
    assert.match(JSON.stringify((await tool.execute("mcp-check", {})).content), /MCP_FIXTURE_OK/);
    pid = Number(await fs.readFile(pidFile, "utf8"));
  } finally { await lifecycle.closePiSession(session); }
  let alive = true;
  for (let attempt = 0; attempt < 100 && alive; attempt++) {
    try { process.kill(pid, 0); await wait(); } catch (error) {
      if (error.code !== "ESRCH") throw error;
      alive = false;
    }
  }
  assert.equal(alive, false, "关闭会话后本地 MCP 子进程必须退出");
}
