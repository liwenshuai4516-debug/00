import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

const base = process.argv[2];
const workspace = path.join(base, "workspace");
const directory = path.join(base, "sessions");
const agentDir = process.env.PI_CODING_AGENT_DIR;
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
// 使用官方 Provider 扩展提供内存流，真实 SDK 执行工具和收尾；没有 HTTP 或模型请求。
const fixture = path.join(base, "fixture.mjs");
await fs.writeFile(fixture, `
import { createAssistantMessageEventStream, getCurrentTools } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-ai"))};
export const requests = globalThis[Symbol.for("desktop-subagent-test")] ??= [];
export const flags = globalThis[Symbol.for("desktop-subagent-flags")] ??= {};
export default function(pi) {
  pi.registerCommand("abort-family", { handler: async (_args, ctx) => ctx.abort() });
  pi.on("before_agent_start", (event) => {
    if (flags.failChild && event.prompt.startsWith("父智能体 ID：")) throw new Error("EXPECTED_CHILD_EXTENSION_FAILURE");
  });
  pi.registerProvider("offline-subagent", {
    baseUrl: "https://example.invalid", apiKey: "offline-only", api: "openai-completions",
    models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 64000, maxTokens: 1024 }],
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const text = message => typeof message.content === "string" ? message.content : (message.content ?? []).filter(b => b.type === "text").map(b => b.text).join("\\n");
      const child = context.messages.some(m => text(m).startsWith("父智能体 ID："));
      const last = context.messages.at(-1);
      requests.push({ child, messages: structuredClone(context.messages), tools: getCurrentTools(context.messages)?.map(t => t.name) ?? [] });
      const response = { role: "assistant", api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), content: [], stopReason: "stop", usage: { input: 5, output: 2,
          cacheRead: 0, cacheWrite: 0, totalTokens: 7, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
      const finish = () => {
        if (child && text(last).includes("BLOCK")) {
          const abort = () => { response.stopReason = "aborted"; stream.push({ type: "error", reason: "aborted", error: response }); };
          if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
          return;
        }
        if (!child && text(last) === "DELEGATE") {
          response.stopReason = "toolUse";
          response.content = ["subagent", "subagent_fork"].map((name, i) => ({ type: "toolCall", id: "delegate-" + requests.length + "-" + i,
            name, arguments: { description: name, prompt: "CHILD_TASK" } }));
        } else if (child && text(last).includes("WRITE_TASK")) {
          response.stopReason = "toolUse";
          response.content = [{ type: "toolCall", id: "write-" + requests.length, name: "write", arguments: { path: "child.txt", content: "CHILD_FILE" } }];
        } else if (child && text(last).includes("REPORT_TASK")) {
          response.stopReason = "toolUse";
          const id = text(last).match(/父智能体 ID：([^\\n]+)/)[1];
          response.content = [{ type: "toolCall", id: "report-" + requests.length, name: "send_message", arguments: { agent_id: id, message: "CHILD_REPORT" } }];
        } else response.content = [{ type: "text", text: child ? (last?.isError ? "CHILD_BLOCKED" : "CHILD_DONE") : text(last).includes("子智能体") ? "PARENT_SUMMARY" : "BASELINE_DONE" }];
        stream.push({ type: "done", reason: response.stopReason, message: response });
      };
      if (child) setTimeout(finish, 15); else queueMicrotask(finish);
      return stream;
    }
  });
}
`);
await fs.writeFile(path.join(agentDir, "extensions", "offline.js"), `export { default } from ${JSON.stringify(pathToFileURL(fixture).href)};`);
const { requests, flags } = await import(pathToFileURL(fixture).href);
const config = { provider: "offline-subagent", modelId: "fixture" };
const widgets = [];
let permissionMode = "full-access";
const options = { permissionController: { currentMode: () => permissionMode },
  askProjectTrust: async () => ({ trusted: true }),
  createUiContext: (_session, ui) => ({ ...ui, setWidget: (key, lines) => widgets.push({ key, lines }) }),
};
const create = (resumePath) => createPiAgent(directory, false, resumePath, workspace, config, undefined, undefined, undefined, options);
let session = await create();
try {
  const originalId = session.sessionId;
  const output = [];
  await sendMessage(session, "BASELINE", () => {}, () => {});
  let childProgress = 0;
  session.desktopAgentProgress = () => childProgress++;
  await sendMessage(session, "DELEGATE", () => {}, () => {}, () => {}, event => output.push(event));
  assert.ok(childProgress > 0, "真实子会话事件向父看门狗报告进展");
  delete session.desktopAgentProgress;
  assert.equal(session.sessionId, originalId);
  assert.equal(session.desktopRuntime.session, session);
  let rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.equal(rows.length, 2);
  assert.ok(rows.every(row => row.status === "completed" && row.output === "CHILD_DONE"));
  assert.ok(rows.every(row => row.usage === 7), "子级用量不重复计算 fork 继承的父级响应");
  assert.ok(output.some(event => event.type === "message_end" && event.message?.content.some(b => b.text === "PARENT_SUMMARY")));
  assert.equal(output.at(-1).type, "agent_settled");
  assert.ok(widgets.some(event => event.lines?.some(line => line.includes("运行中"))));
  const childRequests = requests.filter(request => request.child);
  assert.equal(childRequests.length, 2);
  assert.ok(childRequests.every(request => !request.tools.includes("subagent") && request.tools.includes("send_message")));
  const childTexts = childRequests.map(request => JSON.stringify(request.messages));
  assert.equal(childTexts.filter(text => text.includes("BASELINE_DONE")).length, 1);
  assert.ok(childRequests.every(request => !request.messages.some(message => message.role === "assistant"
    && message.content.some(block => block.type === "toolCall" && block.name === "subagent"))));
  assert.equal((await SessionManager.listAll(directory)).length, 1, "子会话不混入主会话侧栏");
  await assert.rejects(session.desktopSubagents.send("foreign", "task"), /不属于/);
  await assert.rejects(session.desktopSubagents.interrupt("foreign"), /不属于/);

  // 完成后重开父会话，继续同一 child id，恢复历史而非重发初始任务。
  const file = session.sessionFile;
  const childId = rows[0].id;
  await lifecycle.closePiSession(session);
  session = await create(file);
  await session.desktopSubagents.send(childId, "CONTINUE_TASK");
  await sendMessage(session, "COLLECT", () => {}, () => {});
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.equal(rows.find(row => row.id === childId).status, "completed");
  assert.equal(rows.find(row => row.id === childId).usage, 14);
  const continued = requests.filter(request => request.child).at(-1);
  assert.ok(JSON.stringify(continued.messages).includes("CONTINUE_TASK"));
  assert.equal(continued.messages.filter(message => JSON.stringify(message).includes("CHILD_TASK")).length, 1);

  // 权限快照：只读子会话的原生 write 经真正 Pi tool_call 门禁拒绝。
  await session.desktopSubagents.start("spawn", "只读检查", "WRITE_TASK", "read-only");
  await sendMessage(session, "COLLECT", () => {}, () => {});
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.equal(rows.at(-1).output, "CHILD_BLOCKED");
  await assert.rejects(fs.stat(path.join(workspace, "child.txt")), { code: "ENOENT" });
  await session.desktopSubagents.start("spawn", "文件写入", "WRITE_TASK", "full-access");
  await sendMessage(session, "COLLECT", () => {}, () => {});
  assert.equal(await fs.readFile(path.join(workspace, "child.txt"), "utf8"), "CHILD_FILE");
  await session.desktopSubagents.start("spawn", "汇报", "REPORT_TASK", "full-access");
  await sendMessage(session, "COLLECT", () => {}, () => {});
  assert.ok(session.messages.some(message => message.role === "custom" && String(message.content).includes("CHILD_REPORT")));

  // 容量在异步初始化前占用；中断不删除历史，父停止等待所有正在初始化/执行的子级。
  for (let i = 0; i < 8; i++) await session.desktopSubagents.start("spawn", `阻塞 ${i}`, "BLOCK", "full-access");
  await assert.rejects(session.desktopSubagents.start("spawn", "第九个", "BLOCK", "full-access"), /8 个/);
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  await session.desktopSubagents.interrupt(rows.at(-1).id);
  const pending = sendMessage(session, "COLLECT", () => {}, () => {});
  const stop = session.desktopSubagents.stop();
  await session.abort();
  await Promise.all([pending, stop]);
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.ok(rows.slice(-8).every(row => row.status === "stopped"));
  await session.desktopReloadResources();
  await sendMessage(session, "BASELINE", () => {}, () => {});
  assert.equal(session.sessionId, originalId);
  // 崩溃遗留的运行状态不能伪装成完成，也不自动重发；续接须用户确认。
  session.sessionManager.appendCustomEntry("desktop-subagent-state", { owner: session.sessionId, id: childId, status: "running" });
  await lifecycle.closePiSession(session);
  session = await create(file);
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.equal(rows.find(row => row.id === childId).status, "unknown");
  const before = requests.length;
  await assert.rejects(session.desktopSubagents.send(childId, "UNCONFIRMED"), /用户未确认/);
  assert.equal(requests.length, before);
  await session.desktopSubagents.send(childId, "CONFIRMED_NEW_TASK", async () => true);
  await sendMessage(session, "COLLECT", () => {}, () => {});

  // 扩展 ctx.abort() 与桌面停止采用相同的父子收尾语义。
  await session.desktopSubagents.start("spawn", "扩展停止", "BLOCK", "full-access");
  const aborted = sendMessage(session, "COLLECT", () => {}, () => {});
  await new Promise(resolve => setImmediate(resolve));
  await session.prompt("/abort-family");
  await aborted;
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.equal(rows.at(-1).status, "stopped");

  // 子级扩展报错必须成为失败结果，不得继续调用 Provider 或误报完成。
  await sendMessage(session, "BASELINE", () => {}, () => {});
  flags.failChild = true;
  const childRequestsBefore = requests.filter(request => request.child).length;
  await session.desktopSubagents.start("spawn", "扩展失败", "CHILD_TASK", "full-access");
  await sendMessage(session, "COLLECT", () => {}, () => {});
  rows = JSON.parse(session.desktopSubagents.list().content[0].text);
  assert.equal(rows.at(-1).status, "error");
  assert.match(rows.at(-1).output, /EXPECTED_CHILD_EXTENSION_FAILURE/);
  assert.equal(requests.filter(request => request.child).length, childRequestsBefore);
  flags.failChild = false;
  // 内置身份遵循 Pi 配置禁用与第三方同名工具替换语义。
  await lifecycle.closePiSession(session);
  await fs.writeFile(path.join(agentDir, "settings.json"), JSON.stringify({ extensions: ["-builtin:desktop-subagents"] }));
  session = await create(file);
  assert.ok(!session.getAllTools().some(tool => tool.name === "subagent"));
  assert.ok(!session.extensionRunner.getRegisteredCommands().some(command => command.name === "subagents"));
  await lifecycle.closePiSession(session);
  await fs.writeFile(path.join(agentDir, "settings.json"), "{}");
  await fs.writeFile(path.join(agentDir, "extensions", "replacement.js"), `import { Type } from ${JSON.stringify(import.meta.resolve("typebox"))};
    export default function(pi) { pi.registerTool({ name: "subagent", label: "replacement", description: "replacement",
      parameters: Type.Object({}), execute: async () => ({ content: [{ type: "text", text: "replacement" }] }) }); }`);
  session = await create(file);
  assert.equal(session.getAllTools().find(tool => tool.name === "subagent").description, "replacement");
  assert.ok(!session.getAllTools().some(tool => tool.name === "list_agents"));
  console.log("子智能体真实 SDK 离线验证通过：并行、fork、边界汇总、消息、恢复、权限、容量、停止、重载。");
} finally {
  await lifecycle.closePiSession(session);
}
