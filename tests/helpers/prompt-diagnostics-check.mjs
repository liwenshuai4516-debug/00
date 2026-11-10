import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

const base = process.argv[2];
const workspace = path.join(base, "workspace");
const config = { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "fixture-runtime-secret" };
await fs.mkdir(workspace, { recursive: true });
await fs.writeFile(path.join(workspace, "probe.txt"), "离线工具轮次证据");
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
      content: withTool ? [{ type: "toolCall", id: "diagnostic-read", name: "read", arguments: { path: path.join(workspace, "probe.txt") } }]
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
  assert.ok(session.extensionRunner.getRegisteredCommands().some(command => command.name === "diagnostic-command"));
  offlineModel(session);
  return session;
}
const diagnostics = () => logs.filter(item => item.startsWith("[Pi 桌面] 本轮完整系统提示词"));
try {
  const first = await create();
  assert.equal(diagnostics().length, 0, "空会话不伪造运行记录");
  await sendMessage(first, "/diagnostic-command", () => {}, () => {});
  assert.equal(diagnostics().length, 0, "扩展命令不伪造模型运行");
  await sendMessage(first, "第一轮", () => {}, () => {});
  assert.equal(diagnostics().length, 1);
  assert.equal(calls, 2, "工具后的第二次响应不重复打印运行日志");
  const output = diagnostics()[0];
  assert.ok(output.includes(`session=${first.sessionId}`));
  assert.match(output, /EXTENSION_FINAL_PROMPT/);
  assert.doesNotMatch(output, /fixture-runtime-secret|fixture-password-secret|第一轮/);
  assert.match(output, /MCP接入": "已启用/);
  assert.ok(modelPrompts[0].includes("fixture-password-secret"), "脱敏不能修改运行时模型输入");
  await sendMessage(first, "/reload", () => {}, () => {});
  assert.equal(diagnostics().length, 1);
  await sendMessage(first, "重载后运行", () => {}, () => {});
  assert.equal(diagnostics().length, 2, "重载不重复绑定");
  assert.notEqual(diagnostics()[0].match(/round=(\S+)/)[1], diagnostics()[1].match(/round=(\S+)/)[1]);
  const file = first.sessionFile;
  await lifecycle.closePiSession(first);
  const reopened = await create(file);
  assert.equal(reopened.sessionId, first.sessionId);
  await sendMessage(reopened, "恢复后运行", () => {}, () => {});
  assert.equal(diagnostics().length, 3);
  const next = await create();
  await sendMessage(next, "新会话运行", () => {}, () => {});
  assert.equal(diagnostics().length, 4);
  assert.ok(diagnostics()[3].includes(`session=${next.sessionId}`));
  assert.notEqual(next.sessionId, first.sessionId);
  assert.equal(calls, 5);
  const history = await fs.readFile(first.sessionFile, "utf8");
  assert.ok(!history.includes("动态配置开始"), "诊断块不写入会话历史");
} finally {
  for (const session of sessions) await lifecycle.closePiSession(session);
  console.info = info;
}
console.log("真实 SDK 提示词诊断通过");
