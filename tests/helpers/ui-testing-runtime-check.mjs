import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { createPiAgent } from "../../src/main/pi-agent.mjs";
import { openLogin } from "../../src/main/capabilities/ui-testing/login-session.mjs";
import runtimePaths from "../../src/main/capabilities/ui-testing/runtime-paths.js";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

const [base, scenario] = process.argv.slice(2);
const root = fileURLToPath(new URL("../../", import.meta.url));
const runtime = {
  ...runtimePaths.resolveUiTestingRuntime({ isPackaged: false }, root),
  projectConfig: path.join(base, "projects.json"),
};
const workspace = path.join(base, "页面测试 ' workspace");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });

if (scenario === "resources") {
  const agentDir = process.env.PI_CODING_AGENT_DIR;
  const adapter = path.join(base, "pi-mcp-adapter");
  await fs.mkdir(adapter);
  await fs.writeFile(path.join(adapter, "package.json"), JSON.stringify({ name: "pi-mcp-adapter", version: "1.0.0", pi: { extensions: ["index.mjs"] } }));
  await fs.writeFile(path.join(adapter, "index.mjs"), 'export default pi => pi.registerCommand("mcp", { description: "offline replacement", handler: async () => {} });');
  const projectSettingsFile = path.join(workspace, ".pi/settings.json");
  await fs.mkdir(path.dirname(projectSettingsFile), { recursive: true });
  const projectSettings = { defaultThinkingLevel: "off" };
  await fs.writeFile(projectSettingsFile, JSON.stringify(projectSettings));
  for (const enabled of [false, true, "disabled", "mcp-disabled", "replacement"]) {
    const settings = enabled === "disabled" ? { extensions: ["-builtin:desktop-ui-testing"] }
      : enabled === "mcp-disabled" ? { extensions: ["-builtin:mcp"] }
      : enabled === "replacement" ? { packages: [adapter] } : {};
    const settingsFile = path.join(agentDir, "settings.json");
    await fs.writeFile(settingsFile, JSON.stringify(settings));
    const diagnostics = [];
    const session = await createPiAgent(path.join(base, "sessions"), false, undefined, workspace,
      { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "offline-test-only" },
      undefined, undefined, undefined, { uiTestingRuntime: enabled ? runtime : undefined, askProjectTrust: async () => ({ trusted: true }), onDiagnostics: items => diagnostics.push(...items) });
    try {
      const expected = enabled && enabled !== "disabled" ? 1 : 0;
      const extensions = session.resourceLoader.getExtensions().extensions;
      const tools = session.getAllTools().map(tool => tool.name);
      for (const name of ["qa_ui_explore", "qa_ui_save_candidate", "qa_ui_run", "qa_ui_publish"]) {
        assert.equal(extensions.filter(entry => entry.tools.has(name)).length, expected, name);
        assert.equal(tools.filter(item => item === name).length, expected, name);
      }
      assert.equal(tools.filter(name => name.startsWith("qa_ui_")).length, 4 * expected);
      for (const name of ["read", "bash", "edit", "write"]) assert.ok(tools.includes(name), name);
      const skills = session.resourceLoader.getSkills().skills;
      for (const name of ["qa-ui-basic", "qa-ui-execute", "qa-ui-assertion", "qa-test-report"]) {
        assert.equal(skills.filter(item => item.name === name).length, expected, name);
      }
      for (const name of ["qa-ui-intent", "qa-ui-record"]) assert.equal(skills.filter(item => item.name === name).length, 0);
      const manager = session.desktopServices.settingsManager;
      assert.deepEqual(manager.getGlobalSettings(), settings);
      assert.deepEqual(manager.getProjectSettings(), projectSettings);
      if (enabled === "mcp-disabled") {
        assert.deepEqual(manager.getSettings().extensions, ["-builtin:mcp"]);
        assert.ok(!extensions.some(entry => entry.path === "builtin:mcp"));
      }
      if (enabled === "replacement") {
        assert.deepEqual(manager.getSettings().packages, [adapter]);
        assert.ok(extensions.some(entry => entry.path === path.join(adapter, "index.mjs")));
        assert.ok(!extensions.some(entry => entry.path === "builtin:mcp"));
      }
      assert.deepEqual(JSON.parse(await fs.readFile(settingsFile, "utf8")), settings);
      assert.deepEqual(JSON.parse(await fs.readFile(projectSettingsFile, "utf8")), projectSettings);
      assert.deepEqual(diagnostics.filter(item => item.type === "error"), []);
    } finally { await lifecycle.closePiSession(session); }
  }
}

if (scenario === "auto-login") {
  process.env.TMPDIR = base;
  let submissions = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.method === "POST") {
      submissions++;
      let body = "";
      for await (const chunk of request) body += chunk;
      const values = new URLSearchParams(body);
      if (request.url === "/private" && values.get("username") === "fixture-account" && values.get("password") === "fixture-private-password") {
        response.setHeader("Set-Cookie", "fixture_identity=private-fixture-token; HttpOnly; Path=/");
        response.writeHead(302, { Location: "/private" }); response.end(); return;
      }
    }
    if (request.url === "/public" || (request.url === "/private" && request.headers.cookie?.includes("fixture_identity=private-fixture-token"))) {
      response.end('<h1>fixture-reviewer</h1><script>localStorage.setItem("role", "reviewer")</script>'); return;
    }
    response.end('<form method="post"><input name="username"><input name="password" type="password">' +
      (request.url === "/captcha" ? '<input name="captcha" placeholder="验证码">' : '') + '<button>登录</button></form>');
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const origin = "http://127.0.0.1:" + server.address().port;
  const credentials = { account: "fixture-account", password: "fixture-private-password" };
  try {
    for (const route of ["public", "captcha", "private", "invalid"]) {
      const entry = await openLogin(runtime, origin + "/" + route);
      try {
        const result = await entry.auto(credentials, route === "public" || route === "private" ? { authenticated: "h1" } : {});
        assert.equal(result.status, route === "public" ? "not-required" : route === "private" ? "saved" : "manual-required", route);
        assert.ok(!JSON.stringify(result).includes(credentials.password));
        if (route === "captcha") { assert.match(result.reason, /验证码/); assert.equal(submissions, 0); }
        if (route === "private") {
          assert.equal(submissions, 1);
          assert.equal((await fs.stat(entry.directory)).mode & 0o777, 0o700);
          assert.equal((await fs.stat(entry.file)).mode & 0o777, 0o600);
          const state = JSON.parse(await fs.readFile(entry.file, "utf8"));
          assert.equal(state.cookies[0].name, "fixture_identity");
          assert.equal(state.origins[0].localStorage[0].value, "reviewer");
        }
        if (route === "invalid") assert.equal(submissions, 2, "失败仅提交一次");
      } finally { await entry.cleanup(); }
      await assert.rejects(fs.access(entry.directory), { code: "ENOENT" });
    }
    assert.deepEqual((await fs.readdir(base)).filter(name => name.startsWith("qa-ui-auth-") || name.startsWith("playwright_chromiumdev_profile-")), []);
  } finally { await new Promise(resolve => server.close(resolve)); }
}
