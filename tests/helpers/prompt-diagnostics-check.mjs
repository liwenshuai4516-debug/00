import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";
import { TEST_AGENT_PROMPT } from "../../src/main/prompts/test-agent-prompt.mjs";
import { AGENT_SYSTEM_PROMPT } from "../../src/main/prompts/agent-system-prompt.mjs";

const base = process.argv[2];
const workspace = path.join(base, "workspace");
const skillFile = path.join(base, "agent", "skills", "diagnostic-skill", "SKILL.md");
const config = { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "fixture-runtime-secret" };
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(path.dirname(skillFile), { recursive: true });
await fs.writeFile(skillFile, "---\nname: diagnostic-skill\ndescription: 夹具技能描述正文\n---\n离线技能正文");
await fs.mkdir(path.join(base, "agent/extensions"), { recursive: true });
await fs.writeFile(path.join(base, "agent/extensions/prompt.js"), `export default pi => {
  pi.on("session_start", (_event, ctx) => console.info("FIXTURE_SESSION_READY " + ctx.sessionManager.getSessionId()));
  pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\nEXTENSION_FINAL_PROMPT\\npassword=fixture-password-secret" }));
  pi.registerCommand("diagnostic-command", { handler: async () => {} });
  pi.registerCommand("diagnostic-new", { handler: async (_args, ctx) => { await ctx.newSession(); } });
}`);
const logs = [], sessions = [];
const info = console.info;
console.info = message => logs.push(message);
globalThis.fetch = async () => assert.fail("不得请求模型或外部服务");
let calls = 0;
const modelPrompts = [];
function offlineModel(session) {
  session.agent.streamFunction = model => {
    calls++;
    modelPrompts.push(session.systemPrompt);
    const stream = createAssistantMessageEventStream();
    const withTool = calls === 1;
    const reason = withTool ? "toolUse" : "stop";
    queueMicrotask(() => stream.push({ type: "done", reason, message: {
      role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      content: withTool ? [{ type: "toolCall", id: "diagnostic-read", name: "read", arguments: { path: skillFile } }]
        : [{ type: "text", text: "离线完成" }], stopReason: reason,
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    } }));
    return stream;
  };
}
async function create(file) {
  const session = await createPiAgent(path.join(base, "sessions"), false, file, workspace, config);
  sessions.push(session);
  assert.ok(session.systemPrompt.startsWith(TEST_AGENT_PROMPT));
  assert.ok(session.systemPrompt.includes(AGENT_SYSTEM_PROMPT));
  assert.ok(!session.systemPrompt.includes("You are an expert coding assistant operating inside pi"));
  assert.ok(!session.systemPrompt.includes("Use read to examine files instead of cat or sed."));
  assert.ok(session.extensionRunner.getRegisteredCommands().some(command => command.name === "diagnostic-command"));
  offlineModel(session);
  return session;
}
const diagnostics = () => logs.filter(item => item.startsWith("[Pi 桌面] 初始系统提示词"));
const runtimeLogs = () => logs.filter(item => /^\[Pi 桌面\] (本轮运行|工具调用|工具返回|已加载技能)/.test(item));
try {
  const first = await create();
  assert.ok(first.systemPrompt.includes("<available_skills>"), "夹具技能应被原生加载器发现");
  assert.equal(diagnostics().length, 1, "会话创建完成即打印一次初始提示词");
  assert.ok(diagnostics()[0].includes(`session=${first.sessionId}`));
  assert.match(diagnostics()[0], /role=main/);
  await sendMessage(first, "/diagnostic-command", () => {}, () => {});
  assert.equal(diagnostics().length, 1, "扩展命令不重复打印提示词");
  await sendMessage(first, "第一轮", () => {}, () => {});
  assert.equal(diagnostics().length, 1, "运行期不重复打印整段提示词");
  assert.equal(calls, 2, "工具后的第二次响应不重复打印提示词");
  assert.ok(first.messages.some(message => message.role === "toolResult" && message.toolName === "read" && !message.isError), "停止打印不影响原生工具成功执行");
  assert.equal(runtimeLogs().length, 0, "运行期不打印轮次、工具调用、返回或技能加载");
  const output = diagnostics()[0];
  assert.ok(output.includes(TEST_AGENT_PROMPT));
  assert.ok(output.includes(AGENT_SYSTEM_PROMPT));
  assert.ok(output.indexOf(AGENT_SYSTEM_PROMPT) < output.indexOf(TEST_AGENT_PROMPT), "日志先打印桌面系统规则，再打印测试职责");
  for (const name of ["AGENT_SYSTEM_PROMPT", "TEST_AGENT_PROMPT（当前会话测试职责）", "其余系统提示词"]) {
    assert.ok(output.includes(`---------- ${name} 开始 ----------`));
    assert.ok(output.includes(`---------- ${name} 结束 ----------`));
  }
  assert.ok(!output.includes("You are an expert coding assistant operating inside pi"));
  assert.ok(output.includes(`session=${first.sessionId}`));
  assert.doesNotMatch(output, /fixture-runtime-secret|fixture-password-secret|第一轮/);
  assert.match(output, /MCP接入": "已启用/);
  assert.match(output, /当前用户/);
  assert.ok(!output.includes("<available_skills>"), "日志不打印技能目录正文");
  assert.ok(!output.includes("夹具技能描述正文"));
  assert.match(output, /技能目录正文已省略/);
  assert.doesNotMatch(output, /EXTENSION_FINAL_PROMPT/, "初始日志不包含运行期 before_agent_start 的改写");
  assert.ok(modelPrompts[0].includes("fixture-password-secret"), "扩展运行期改写只进入模型输入，不修改日志脱敏");
  assert.ok(modelPrompts[0].startsWith(TEST_AGENT_PROMPT + "\n\n" + AGENT_SYSTEM_PROMPT), "日志排序不改变模型输入顺序");
  assert.ok(modelPrompts[0].includes("<available_skills>"), "技能目录仍发送给模型");
  await sendMessage(first, "/skill:diagnostic-skill 附加说明", () => {}, () => {});
  assert.equal(diagnostics().length, 1);
  assert.ok(first.messages.some(message => message.role === "user" && JSON.stringify(message.content).includes("离线技能正文")), "技能仍通过 SDK 动态展开");
  assert.equal(runtimeLogs().length, 0, "显式加载技能也不打印运行日志");
  await sendMessage(first, "/reload", () => {}, () => {});
  assert.equal(diagnostics().length, 1, "重载不重复打印提示词");
  await sendMessage(first, "重载后运行", () => {}, () => {});
  assert.equal(diagnostics().length, 1);
  const file = first.sessionFile;
  await lifecycle.closePiSession(first);
  const reopened = await create(file);
  assert.equal(reopened.sessionId, first.sessionId);
  assert.equal(diagnostics().length, 2, "恢复会话重新创建时再打印一次初始提示词");
  assert.ok(diagnostics()[1].includes(TEST_AGENT_PROMPT), "恢复会话打印当前配置提示词");
  assert.ok(!diagnostics()[1].includes("第一轮"), "恢复日志不混入历史消息");
  await sendMessage(reopened, "恢复后运行", () => {}, () => {});
  assert.equal(diagnostics().length, 2);
  const next = await create();
  assert.equal(diagnostics().length, 3);
  await sendMessage(next, "新会话运行", () => {}, () => {});
  assert.equal(diagnostics().length, 3);
  assert.ok(diagnostics()[2].includes(`session=${next.sessionId}`));
  assert.notEqual(next.sessionId, first.sessionId);
  await sendMessage(next, "/diagnostic-new", () => {}, () => {});
  const replacement = next.desktopRuntime.session;
  sessions.push(replacement);
  assert.notEqual(replacement.sessionId, next.sessionId);
  assert.equal(diagnostics().length, 4, "扩展替换会话也打印一次初始提示词");
  for (const session of [first, reopened, next, replacement]) {
    const promptIndex = logs.findIndex(line => line.startsWith("[Pi 桌面] 初始系统提示词") && line.includes(`session=${session.sessionId}`));
    const readyIndex = logs.indexOf(`FIXTURE_SESSION_READY ${session.sessionId}`);
    assert.ok(readyIndex >= 0 && readyIndex < promptIndex, "初始提示词必须在扩展绑定完成后打印");
    assert.ok(logs[promptIndex].indexOf(AGENT_SYSTEM_PROMPT) < logs[promptIndex].indexOf(TEST_AGENT_PROMPT), "恢复、新建和替换会话均按日志顺序分段");
  }
  assert.equal(calls, 6);
  assert.equal(runtimeLogs().length, 0, "重载、恢复与新会话均不追加运行期日志");
  const history = await fs.readFile(first.sessionFile, "utf8");
  assert.ok(!history.includes("动态配置开始"), "诊断块不写入会话历史");
} finally {
  for (const session of sessions) await lifecycle.closePiSession(session);
  console.info = info;
}
console.log("真实 SDK 提示词诊断通过");
