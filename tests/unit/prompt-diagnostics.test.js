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

test("工具调用与技能加载在运行期打印，绑定本身不重复打印整段提示词", async () => {
  const { bindPromptDiagnostics } = await import("../../src/main/resources/prompt-diagnostics.mjs");
  const workspace = path.join(os.tmpdir(), "诊断技能工作区");
  const skillPath = path.join(workspace, ".pi", "skills", "qa-ui-basic", "SKILL.md");
  const session = {
    sessionId: "fixture-skill-session",
    systemPrompt: [
      "<skills>", "<available_skills>", "  <skill>",
      "    <name>qa-ui-basic</name>",
      "    <description>夹具技能描述</description>",
      "  </skill>", "</available_skills>", "</skills>",
    ].join("\n"),
    sessionManager: { getCwd: () => workspace, getSessionDir: () => path.join(workspace, "sessions") },
    getAllTools: () => [], extensionRunner: { hasHandlers: () => false },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "qa-ui-basic", filePath: skillPath }] }) },
    subscribe: handler => { listeners.push(handler); return () => {}; },
  };
  const listeners = [];
  const logged = [];
  const info = console.info;
  console.info = message => logged.push(message);
  try {
    bindPromptDiagnostics(session, { knownSecrets: [] });
    const emit = event => listeners[0](event);
    emit({ type: "agent_start" });
    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "t1", args: { path: skillPath } });
    emit({ type: "tool_execution_end", toolName: "read", toolCallId: "t1", isError: false, durationMs: 1234 });
    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "t2", args: { path: path.join(workspace, "notes", "SKILL.md") } });
    emit({ type: "tool_execution_start", toolName: "read", toolCallId: "t3", args: { path: skillPath } });
    emit({ type: "message_end", message: { role: "user", content: `<skill name="qa-ui-basic" location="${skillPath}">\n技能正文\n</skill>` } });
    emit({ type: "tool_execution_start", toolName: "bash", toolCallId: "t4", args: { command: `cat ${skillPath}` } });
    emit({ type: "tool_execution_end", toolName: "bash", toolCallId: "t4", isError: true });
    emit({ type: "message_end", message: { role: "user", content: "普通消息" } });
    emit({ type: "message_end", message: { role: "assistant", content: "回复" } });
  } finally {
    console.info = info;
  }
  assert.equal(logged.filter(line => line.includes("系统提示词")).length, 0, "运行期不重复打印整段提示词");
  const runs = logged.filter(line => line.startsWith("[Pi 桌面] 本轮运行"));
  assert.equal(runs.length, 1, "每次运行留一条轮次标记");
  assert.match(runs[0], /session=fixture-skill-session/);
  const calls = logged.filter(line => line.startsWith("[Pi 桌面] 工具调用"));
  const returns = logged.filter(line => line.startsWith("[Pi 桌面] 工具返回"));
  assert.equal(calls.length, 4, "每次工具调用一条，不合并");
  assert.equal(returns.length, 2);
  assert.match(calls[0], /tool=read/);
  assert.match(returns[0], /tool=read status=ok 1234 ms/);
  assert.match(returns[1], /tool=bash status=error \d+ ms/);
  assert.match(calls[0], /call=t1/);
  assert.match(returns[0], /call=t1/);
  assert.match(returns[1], /日志观察计时/);
  assert.ok(!logged.join("\n").includes(`cat ${skillPath}`), "命令正文与参数不进入日志");
  assert.equal(logged.filter(line => line.includes("夹具技能描述")).length, 0, "目录正文不进入日志");
  const loaded = logged.filter(line => line.startsWith("[Pi 桌面] 已加载技能"));
  assert.equal(loaded.length, 2, "同轮重复 read、普通 read 与 bash 不产生技能加载日志");
  assert.match(loaded[0], /name="qa-ui-basic" source=read/);
  assert.match(loaded[1], /name="qa-ui-basic" source=explicit/);
  const round = calls[0].match(/round=(\S+)/)[1];
  assert.ok(loaded.every(line => line.includes(`round=${round}`)), "加载日志与工具日志属于同一轮次");
  assert.ok(loaded.every(line => line.includes(`session=fixture-skill-session`)));
  assert.ok(loaded.every(line => line.includes(`path=${skillPath}`)));
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

test("真实 SDK 会话创建记录初始提示词，运行期记录工具调用，重载、恢复和新会话不串日志（不请求模型）", async t => {
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
