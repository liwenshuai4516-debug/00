const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

test("日志副本脱敏凭据并保留普通提示词内容", async () => {
  const { redactPromptLog } = await import("../../src/main/resources/prompt-diagnostics.mjs");
  const original = [
    "你是测试 Agent，默认中文；使用 read、bash。",
    'apiKey: "fixture-api-secret"', "password='fixture password secret'",
    "Authorization: Bearer fixture-auth-secret", "Cookie: session=fixture-cookie-secret; other=fixture-other-cookie",
    '"refresh_token": "fixture-refresh-secret", "secret": "fixture-secret"',
    "https://name:fixture-url-secret@example.invalid?token=fixture-query-secret",
    "known-fixture-secret", "-----BEGIN PRIVATE KEY-----\nfixture-private-secret\n-----END PRIVATE KEY-----",
  ].join("\n");
  const logged = redactPromptLog(original, ["known-fixture-secret"]);
  assert.ok(logged.startsWith("你是测试 Agent，默认中文；使用 read、bash。"));
  assert.doesNotMatch(logged, /fixture-|known-fixture-secret/);
  assert.match(original, /fixture-api-secret/);
});

test("日志北京时间、会话真实路径与 MCP 启用/未加载状态", async () => {
  const { formatPromptDiagnostics } = await import("../../src/main/resources/prompt-diagnostics.mjs");
  const workspace = path.join(os.tmpdir(), "诊断工作区");
  const session = {
    sessionId: "fixture-session", systemPrompt: "角色：测试；语言：中文；最终回答与技能规则。",
    sessionManager: { getCwd: () => workspace, getSessionDir: () => path.join(workspace, "sessions") },
    getAllTools: () => [{ name: "read" }, { name: "mcp__fixture__ping", exposure: "deferred" }],
    extensionRunner: { hasHandlers: () => true },
  };
  const options = { agentDir: path.join(workspace, "agent"), currentUser: "fixture-user", now: new Date("2026-11-10T23:30:00Z") };
  const output = formatPromptDiagnostics(session, options);
  assert.match(output, /2026\/11\/11 07:30:00 Asia\/Shanghai/);
  assert.ok(output.includes(session.systemPrompt));
  assert.match(output, /session=fixture-session/);
  assert.match(output, /fixture-user/);
  assert.ok(output.includes(JSON.stringify(workspace)));
  assert.ok(output.includes(JSON.stringify(process.execPath)));
  assert.match(output, /MCP接入": "已启用/);
  assert.match(output, /mcp__fixture__ping/);
  session.extensionRunner.hasHandlers = () => false;
  assert.match(formatPromptDiagnostics(session, options), /MCP接入": "未加载/);
});

test("真实 SDK 每次运行记录实际提示词，重载、恢复和新会话不串日志（不请求模型）", async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "prompt-diagnostics-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留检查现场：${base}\n`));
  const result = await promisify(execFile)(process.execPath, [
    "--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
    path.resolve(__dirname, "../helpers/prompt-diagnostics-check.mjs"), base,
  ], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") },
    encoding: "utf8", timeout: 120000,
  });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /真实 SDK 提示词诊断通过/);
  passed = true;
});
