import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import adapter from "../../src/main/adapters/message-adapter.js";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

const base = process.argv[2], workspace = path.join(base, "workspace");
const skillFile = path.join(workspace, ".pi/skills/demo/SKILL.md");
await fs.mkdir(path.dirname(skillFile), { recursive: true });
await fs.writeFile(skillFile, "---\nname: demo\ndescription: 离线输出测试技能\n---\n只读取此文件。");
const config = { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "offline-test-only" };
const session = await createPiAgent(path.join(base, "sessions"), false, undefined, workspace, config,
  undefined, undefined, undefined, { askProjectTrust: async () => ({ trusted: true }) });
let responseIndex = 0;
let subscriptions = 0;
const subscribe = session.subscribe.bind(session);
session.subscribe = listener => {
  subscriptions++;
  const unsubscribe = subscribe(listener);
  return () => { subscriptions--; unsubscribe(); };
};
// 只替换公开 Agent 的模型流函数；会话、原生工具执行及历史保存仍由真实 SDK 完成。
session.agent.streamFunction = model => {
  const stream = createAssistantMessageEventStream();
  const withTool = responseIndex++ % 2 === 0;
  const response = {
    role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
    content: [], stopReason: withTool ? "toolUse" : "stop",
    usage: { input: 10, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 13, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
  };
  queueMicrotask(() => {
    stream.push({ type: "start", partial: response });
    response.content.push({ type: "thinking", thinking: "核对技能文件。", thinkingSignature: "NOT_FOR_UI" });
    stream.push({ type: "thinking_start", contentIndex: 0, partial: response });
    stream.push({ type: "thinking_delta", contentIndex: 0, delta: "核对技能文件。", partial: response });
    stream.push({ type: "thinking_end", contentIndex: 0, content: "核对技能文件。", partial: response });
    response.content.push({ type: "text", text: withTool ? "先读取技能。" : "**离线完成**" });
    stream.push({ type: "text_delta", contentIndex: 1, delta: response.content[1].text, partial: response });
    stream.push({ type: "text_end", contentIndex: 1, content: response.content[1].text, partial: response });
    if (withTool) {
      const call = { type: "toolCall", id: `read-${responseIndex}`, name: "read", arguments: { path: skillFile } };
      response.content.push(call);
      stream.push({ type: "toolcall_start", contentIndex: 2, partial: response });
      stream.push({ type: "toolcall_delta", contentIndex: 2, delta: JSON.stringify(call.arguments), partial: response });
      stream.push({ type: "toolcall_end", contentIndex: 2, toolCall: call, partial: response });
    }
    stream.push({ type: "done", reason: response.stopReason, message: response });
  });
  return stream;
};
try {
  for (const input of ["请读取技能", "/skill:demo 检查"]) {
    const output = [];
    await sendMessage(session, input, () => {}, () => {}, () => {}, event => output.push(structuredClone(event)));
    assert.equal(output.filter(event => event.type === "turn_start").length, 2);
    assert.equal(output.filter(event => event.type === "turn_end").length, 2);
    assert.equal(output.at(-1).type, "agent_settled");
    assert.ok(output.some(event => event.type === "tool_execution_end" && event.skill?.name === "demo" && !event.isError));
    assert.equal(output.some(event => event.message?.skill?.source === "explicit"), input.startsWith("/skill:"));
    assert.doesNotMatch(JSON.stringify(output), /NOT_FOR_UI|thinkingSignature|"partial"/);
    assert.ok(output.every(event => event.requestSessionId === session.sessionId));
    assert.equal(subscriptions, 0);
  }
  const history = adapter.toHistory(session.messages, { includeTrace: true, parseSkillBlock: session.desktopParseSkillBlock,
    skills: session.resourceLoader.getSkills().skills, cwd: workspace });
  assert.equal(history.filter(item => item.output?.role === "assistant").length, 4);
  assert.equal(history.filter(item => item.output?.skill?.source === "read").length, 2);
  assert.equal(history.filter(item => item.skill?.source === "history").length, 1);
  assert.ok(session.sessionFile);
  assert.match(await fs.readFile(session.sessionFile, "utf8"), /离线完成/);
  const prompt = session.prompt;
  session.prompt = async () => { throw Error("模拟请求异常"); };
  await assert.rejects(sendMessage(session, "失败", () => {}, () => {}), /模拟请求异常/);
  assert.equal(subscriptions, 0);
  session.prompt = prompt;
  let replacementListener;
  const replacement = { sessionId: "replacement", resourceLoader: session.resourceLoader, sessionManager: session.sessionManager,
    subscribe(listener) { replacementListener = listener; return () => { replacementListener = undefined; }; } };
  session.prompt = async () => {
    for (const listener of session.desktopRuntimeListeners) listener(replacement);
    replacementListener({ type: "agent_start" });
    replacementListener({ type: "agent_settled", aborted: false });
  };
  const rebound = [];
  await sendMessage(session, "替换", () => {}, () => {}, () => {}, event => rebound.push(event));
  assert.ok(rebound.every(event => event.requestSessionId === session.sessionId && event.sessionId === "replacement"));
  assert.equal(replacementListener, undefined);
  assert.equal(subscriptions, 0);
  session.prompt = prompt;
  console.log("真实 Pi 1.4.0 离线流、两 turn、原生 read、技能展开和历史输出通过");
} finally {
  await lifecycle.closePiSession(session, "exit");
}
