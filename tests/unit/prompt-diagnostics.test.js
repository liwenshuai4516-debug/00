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

test("日志省略技能目录正文，只保留可用数量；原文长度仍按未省略提示词计", async () => {
  const { stripSkillsCatalog, formatPromptDiagnostics } = await import("../../src/main/resources/prompt-diagnostics.mjs");
  const catalog = [
    "<skills>",
    "The following skills provide specialized instructions for specific tasks.",
    "Use the read tool to load a skill's file when the task matches its description.",
    "<available_skills>",
    "  <skill>",
    "    <name>qa-ui-basic</name>",
    "    <description>夹具技能描述</description>",
    "  </skill>",
    "  <skill>",
    "    <name>qa-ui-execute</name>",
    "    <description>第二个夹具技能</description>",
    "  </skill>",
    "</available_skills>",
    "</skills>",
  ].join("\n");
  const prompt = `角色：测试\n\n${catalog}\n\n<cwd>/workspace</cwd>`;
  const stripped = stripSkillsCatalog(prompt);
  assert.doesNotMatch(stripped.prompt, /qa-ui-basic|夹具技能描述|available_skills/);
  assert.match(stripped.prompt, /可用技能 2 个/);
  assert.ok(stripped.prompt.startsWith("角色：测试\n\n<skills>"), "保留目录前后的提示词与分段");
  assert.ok(stripped.prompt.includes("<cwd>/workspace</cwd>"));
  assert.ok(stripped.omitted > 0);
  const plain = stripSkillsCatalog("没有技能目录的提示词");
  assert.deepEqual(plain, { prompt: "没有技能目录的提示词", omitted: 0 });

  const session = {
    sessionId: "fixture-strip-session", systemPrompt: prompt,
    sessionManager: { getCwd: () => "/workspace", getSessionDir: () => "/workspace/sessions" },
    getAllTools: () => [], extensionRunner: { hasHandlers: () => false },
  };
  const output = formatPromptDiagnostics(session, { agentDir: "/agent", currentUser: "fixture-user", now: new Date("2026-11-10T23:30:00Z") });
  assert.doesNotMatch(output, /夹具技能描述|available_skills/);
  assert.match(output, /初始系统提示词（技能目录已省略）/);
  assert.ok(output.includes(`${prompt.length} 字符（原文长度；日志凭据脱敏）`));
});

test("日志先打印 AGENT_SYSTEM_PROMPT 再打印会话 TEST_AGENT_PROMPT，各段独立分隔且不改模型原文", async () => {
  const { formatPromptDiagnostics } = await import("../../src/main/resources/prompt-diagnostics.mjs");
  const agentSystemPrompt = "桌面规则夹具", testAgentPrompt = "会话自定义测试职责 password=fixture-secret";
  const prompt = `${testAgentPrompt}\n\n${agentSystemPrompt}\n\nSYSTEM.md 及项目上下文夹具`;
  const session = {
    sessionId: "fixture-order", systemPrompt: prompt,
    sessionManager: { getCwd: () => "/workspace", getSessionDir: () => "/workspace/sessions" },
    getAllTools: () => [], extensionRunner: { hasHandlers: () => false },
  };
  const options = { agentDir: "/agent", currentUser: "fixture-user", agentSystemPrompt, testAgentPrompt };
  const output = formatPromptDiagnostics(session, options);
  assert.ok(output.includes("---------- AGENT_SYSTEM_PROMPT 开始 ----------\n桌面规则夹具\n---------- AGENT_SYSTEM_PROMPT 结束 ----------"));
  assert.ok(output.includes("---------- TEST_AGENT_PROMPT（当前会话测试职责） 开始 ----------\n会话自定义测试职责 password=[已脱敏]\n---------- TEST_AGENT_PROMPT（当前会话测试职责） 结束 ----------"));
  assert.ok(output.includes("---------- 其余系统提示词 开始 ----------\nSYSTEM.md 及项目上下文夹具\n---------- 其余系统提示词 结束 ----------"));
  assert.ok(output.indexOf(agentSystemPrompt) < output.indexOf("会话自定义测试职责"));
  assert.ok(output.indexOf("会话自定义测试职责") < output.indexOf("SYSTEM.md 及项目上下文夹具"));
  assert.equal(session.systemPrompt, prompt);
  assert.doesNotMatch(output, /fixture-secret/);

  session.systemPrompt = "扩展已替换整个提示词";
  const replaced = formatPromptDiagnostics(session, options);
  assert.ok(replaced.includes(session.systemPrompt));
  assert.doesNotMatch(replaced, /桌面规则夹具|会话自定义测试职责|AGENT_SYSTEM_PROMPT 开始/);
});

test("会话创建时打印一次初始系统提示词，失败只报告未确认", async () => {
  const { logInitialPrompt } = await import("../../src/main/resources/prompt-diagnostics.mjs");
  const session = {
    sessionId: "fixture-init-session", systemPrompt: "角色：测试；语言：中文。",
    sessionManager: { getCwd: () => "/workspace", getSessionDir: () => "/workspace/sessions" },
    getAllTools: () => [], extensionRunner: { hasHandlers: () => false },
  };
  const logged = [], errors = [];
  const info = console.info, error = console.error;
  console.info = message => logged.push(message);
  console.error = message => errors.push(message);
  try {
    logInitialPrompt(session, { agentDir: "/agent", currentUser: "fixture-user", role: "main" });
    assert.equal(logged.filter(line => line.startsWith("[Pi 桌面] 初始系统提示词")).length, 1);
    assert.match(logged[0], /role=main/);
    assert.match(logged[0], /session=fixture-init-session/);
    assert.ok(logged[0].includes(session.systemPrompt));
    logInitialPrompt(session, { agentDir: "/agent", currentUser: "fixture-user", role: "subagent" });
    assert.equal(logged.length, 2);
    assert.match(logged[1], /role=subagent/);
    session.getAllTools = () => { throw new Error("夹具失败"); };
    const before = logged.length;
    logInitialPrompt(session, { agentDir: "/agent", currentUser: "fixture-user" });
    assert.equal(logged.length, before, "失败时不输出半截提示词");
    assert.equal(errors.length, 1);
    assert.match(errors[0], /初始系统提示词日志记录失败/);
  } finally {
    console.info = info;
    console.error = error;
  }
});

test("真实 SDK 仅在启动记录提示词，工具和技能动态执行不追加日志（不请求模型）", async t => {
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
