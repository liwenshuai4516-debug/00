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
  pi.on("before_agent_start", event => ({ systemPrompt: event.systemPrompt + "\\nEXTENSION_FINAL_PROMPT\\npassword=fixture-password-secret" }));
  pi.registerCommand("diagnostic-command", { handler: async () => {} });
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
const diagnostics = () => logs.filter(item => item.startsWith("[Pi 桌面] 本轮系统提示词"));
const loadedSkills = () => logs.filter(item => item.startsWith("[Pi 桌面] 已加载技能"));
try {
  const first = await create();
  assert.ok(first.systemPrompt.includes("<available_skills>"), "夹具技能应被原生加载器发现");
  assert.equal(diagnostics().length, 0, "空会话不伪造运行记录");
  await sendMessage(first, "/diagnostic-command", () => {}, () => {});
  assert.equal(diagnostics().length, 0, "扩展命令不伪造模型运行");
  await sendMessage(first, "第一轮", () => {}, () => {});
  assert.equal(diagnostics().length, 1);
  assert.equal(calls, 2, "工具后的第二次响应不重复打印运行日志");
  const output = diagnostics()[0];
  assert.ok(output.includes(TEST_AGENT_PROMPT));
  assert.ok(!output.includes("You are an expert coding assistant operating inside pi"));
  assert.ok(output.includes(`session=${first.sessionId}`));
  assert.match(output, /EXTENSION_FINAL_PROMPT/);
  assert.doesNotMatch(output, /fixture-runtime-secret|fixture-password-secret|第一轮/);
  assert.match(output, /MCP接入": "已启用/);
  assert.ok(!output.includes("<available_skills>"), "日志不打印技能目录正文");
  assert.ok(!output.includes("夹具技能描述正文"));
  assert.match(output, /技能目录正文已省略/);
  assert.ok(modelPrompts[0].includes("fixture-password-secret"), "脱敏不能修改运行时模型输入");
  assert.ok(modelPrompts[0].includes("<available_skills>"), "技能目录仍发送给模型");
  assert.equal(loadedSkills().length, 1, "原生 read 命中技能文件时打印一次加载");
  assert.match(loadedSkills()[0], /name="diagnostic-skill" source=read/);
  await sendMessage(first, "/skill:diagnostic-skill 附加说明", () => {}, () => {});
  assert.equal(diagnostics().length, 2);
  assert.equal(loadedSkills().length, 2);
  assert.match(loadedSkills()[1], /name="diagnostic-skill" source=explicit/);
  assert.ok(loadedSkills()[1].includes(diagnostics()[1].match(/round=(\S+)/)[1]), "加载日志与提示词日志同一轮次");
  await sendMessage(first, "/reload", () => {}, () => {});
  assert.equal(diagnostics().length, 2);
  await sendMessage(first, "重载后运行", () => {}, () => {});
  assert.equal(diagnostics().length, 3, "重载不重复绑定");
  assert.notEqual(diagnostics()[0].match(/round=(\S+)/)[1], diagnostics()[2].match(/round=(\S+)/)[1]);
  const file = first.sessionFile;
  await lifecycle.closePiSession(first);
  const reopened = await create(file);
  assert.equal(reopened.sessionId, first.sessionId);
  await sendMessage(reopened, "恢复后运行", () => {}, () => {});
  assert.equal(diagnostics().length, 4);
  const next = await create();
  await sendMessage(next, "新会话运行", () => {}, () => {});
  assert.equal(diagnostics().length, 5);
  assert.ok(diagnostics()[4].includes(`session=${next.sessionId}`));
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(calls, 6);
  assert.equal(loadedSkills().length, 2, "无技能重复加载时不追加日志");
  const history = await fs.readFile(first.sessionFile, "utf8");
  assert.ok(!history.includes("动态配置开始"), "诊断块不写入会话历史");
} finally {
  for (const session of sessions) await lifecycle.closePiSession(session);
  console.info = info;
}
console.log("真实 SDK 提示词诊断通过");
