import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import sessionsModule from "../../src/main/services/session-service.js";
import chatsModule from "../../src/main/services/chat-service.js";
import statesModule from "../../src/main/storage/session-state-store.js";
import permissionsModule from "../../src/main/services/permission-service.js";

const base = process.argv[2];
const workspace = path.join(base, "workspace");
await fs.mkdir(workspace, { recursive: true });
const store = statesModule.createSessionStateStore(path.join(base, "state"));
const permissions = permissionsModule.createPermissionService(path.join(base, "permissions.json"));
let modelRequests = 0, firstSession, blocked;
const started = Promise.withResolvers();
const prompts = [];
// 真实 SDK 运行生命周期与历史落盘；只用内存模型流，任何网络请求均视为错误。
globalThis.fetch = async () => assert.fail("离线夹具不得请求网络");
const sessions = sessionsModule.createSessionService(path.join(base, "sessions"), async (directory, resume, file, cwd, recovery, options) => {
  const session = await createPiAgent(directory, resume, file, cwd, {
    provider: "openai", modelId: firstSession ? "gpt-4o" : "gpt-4", apiKey: "offline-test-only",
  }, recovery, options, undefined, { permissionController: permissions, askProjectTrust: async () => ({ trusted: true }) });
  if (!firstSession) {
    await permissions.save({ mode: "read-only", scope: "session", sessionId: session.sessionId });
  }
  session.settingsManager.setRetryEnabled(false);
  session.settingsManager.setCompactionEnabled(false);
  session.agent.streamFunction = (model, context, streamOptions) => {
    modelRequests++;
    prompts.push(context.messages.at(-1));
    const stream = createAssistantMessageEventStream();
    const response = {
      role: "assistant", api: model.api, provider: model.provider, model: model.id,
      timestamp: Date.now(), content: [], stopReason: "stop",
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      if (modelRequests === 1) {
        response.stopReason = "error";
        response.errorMessage = "context_length_exceeded: maximum context length exceeded";
        stream.push({ type: "error", reason: "error", error: response });
      } else if (blocked) {
        const abort = () => {
          blocked = false;
          response.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: response });
        };
        if (streamOptions?.signal?.aborted) abort();
        else streamOptions?.signal?.addEventListener("abort", abort, { once: true });
        started.resolve();
      } else {
        stream.push({ type: "start", partial: response });
        response.content.push({ type: "text", text: "离线任务已继续并完成。" });
        stream.push({ type: "text_delta", contentIndex: 0, delta: response.content[0].text, partial: response });
        stream.push({ type: "text_end", contentIndex: 0, content: response.content[0].text, partial: response });
        stream.push({ type: "done", reason: "stop", message: response });
      }
    });
    return stream;
  };
  firstSession ??= session;
  return session;
}, () => workspace, undefined, store);
let clock;
const outputs = [];
const chat = chatsModule.createChatService(sessions, async () => sendMessage, undefined, store,
  undefined, undefined, callbacks => {
    clock = callbacks;
    return { touch() {}, dispose() {} };
  });

async function send(text) {
  const session = await sessions.getSession();
  const state = await store.load(session.sessionId);
  const saved = await store.saveDraft(session.sessionId, workspace, text, state?.draft.revision ?? 0);
  return chat.send(text, () => {}, () => {}, () => {},
    { sessionId: session.sessionId, revision: saved.draft.revision }, () => {}, event => outputs.push(event));
}

try {
  const result = await send("启动看门狗，执行离线长期任务");
  assert.equal(result.outcome, "completed");
  assert.equal(result.sessionChanged, true);
  const next = await sessions.getSession();
  assert.notEqual(next.sessionId, firstSession.sessionId);
  assert.equal(next.model.id, "gpt-4", "新会话必须采用原模型，不能采用工厂后备 gpt-4o");
  assert.equal(next.sessionManager.getCwd(), workspace);
  assert.equal(permissions.currentMode({ sessionId: next.sessionId, workspace }), "read-only",
    "自动交接必须保持原会话权限，不能采用新对话默认 ask 或扩大权限");
  assert.equal(modelRequests, 2);
  assert.match(JSON.stringify(prompts[1]), /自动交接.*执行离线长期任务/s);
  assert.ok(outputs.every(event => event.requestSessionId === firstSession.sessionId));
  assert.equal((await store.load(firstSession.sessionId)).pendingSend, null);
  assert.equal((await store.load(next.sessionId)).watchdogEnabled, true);
  assert.match(await fs.readFile(firstSession.sessionFile, "utf8"), /context_length_exceeded/);
  assert.match(await fs.readFile(firstSession.sessionFile, "utf8"), /desktop-watchdog-handoff/);
  assert.match(await fs.readFile(next.sessionFile, "utf8"), /离线任务已继续并完成/);

  blocked = true;
  const pending = send("继续第二批任务");
  await started.promise;
  clock.onTimeout();
  const continued = await pending;
  assert.equal(continued.outcome, "completed");
  assert.equal(continued.stopped, false);
  assert.equal((await sessions.getSession()).sessionId, next.sessionId);
  assert.equal(modelRequests, 4);
  assert.match(JSON.stringify(prompts[3]), /看门狗自动恢复/);
  assert.equal(chat.isBusy(), false);
  assert.equal((await store.load(next.sessionId)).pendingSend, null);
  console.log("通过：真实 SDK 上下文错误自动交接，沿用目录与模型；超时取消后原会话自动继续；历史和发送快照正确收尾。");
} finally {
  await sessions.closeSession();
}
