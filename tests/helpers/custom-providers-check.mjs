import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { ModelRuntime } from "@mariozechner/pi-coding-agent";
import { createPiAgent, sendMessage } from "../../src/main/pi-agent.mjs";
import sessionModule from "../../src/main/services/session-service.js";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";
import sessionState from "../../src/main/storage/session-state-store.js";

const [root, scenario] = process.argv.slice(2);
const agentDir = process.env.PI_CODING_AGENT_DIR;
const workspace = path.join(root, "workspace");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
const configPath = path.join(agentDir, "models.json");
const settingsPath = path.join(agentDir, "settings.json");
const provider = baseUrl => ({ baseUrl, api: "openai-completions", apiKey: "$CUSTOM_TEST_KEY", models: [{ id: "same", contextWindow: 32768, maxTokens: 1024 }] });
const writeConfig = providers => fs.writeFile(configPath, JSON.stringify({ providers }));
process.env.CUSTOM_TEST_KEY = "offline-fixture-key";
const create = (dir, resume, file, cwd, recovery, options) => createPiAgent(dir, resume, file, cwd, {}, recovery, options);
const service = sessionModule.createSessionService(path.join(root, "sessions"), create, () => workspace);
if (scenario !== "stream") globalThis.fetch = async () => assert.fail("离线验证不得访问网络");

if (scenario === "startup") {
  await writeConfig({ alpha: provider("https://alpha.invalid/v1") });
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "alpha", defaultModel: "same" }));
  const refresh = ModelRuntime.prototype.refresh;
  let catalogChecks = 0;
  ModelRuntime.prototype.refresh = async function (...args) {
    catalogChecks++;
    return refresh.apply(this, args);
  };
  try {
    const session = await service.getSession();
    assert.equal(session.model.provider, "alpha");
    assert.equal(catalogChecks, 1, "没有扩展登记的初始化只检查一次模型目录");
    assert.ok((await service.listModels()).models.some(model => model.provider === "alpha"));
  } finally {
    ModelRuntime.prototype.refresh = refresh;
    await service.closeSession();
  }
}

if (scenario === "unavailable-startup") {
  await writeConfig({ alpha: provider("https://alpha.invalid/v1") });
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "alpha", defaultModel: "same" }));
  const previous = await service.getSession();
  previous.sessionManager.appendMessage({ role: "user", content: "保留的旧对话", timestamp: Date.now() });
  previous.sessionManager.appendModelChange("desktop-profile-obsolete", "same");
  const id = previous.sessionId, file = previous.sessionFile;
  await service.closeSession();
  const before = await fs.readFile(file, "utf8");
  const store = sessionState.createSessionStateStore(path.join(root, "state"));
  await store.registerSession(id, workspace, "history", { provider: "desktop-profile-obsolete", modelId: "same" });
  await store.saveDraft(id, workspace, "旧对话尚未发送的输入", 0);
  const saved = await store.load(id);
  const reopened = sessionModule.createSessionService(path.join(root, "sessions"), create, () => workspace, undefined, store);
  try {
    // 启动时不让已移除模型的历史阻断模型目录；新对话须有不同编号和明确提示。
    const [history, list] = await Promise.all([reopened.loadHistory(), reopened.listModels()]);
    assert.deepEqual(history, []);
    const fresh = await reopened.getSession();
    assert.notEqual(fresh.sessionId, id);
    assert.equal(list.provider, "alpha");
    assert.ok(list.models.some(model => model.provider === "alpha"));
    assert.match(list.warning, /已新建对话/);
    assert.deepEqual(fresh.messages, []);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await store.load(id), saved);
    // 明确打开原记录不能默默换模型，也不能替换已可用的新对话。
    await assert.rejects(reopened.openSession(id), /Pi 未找到模型/);
    assert.equal((await reopened.getSession()).sessionId, fresh.sessionId);
    await reopened.newChat();
    assert.equal((await reopened.listModels()).warning, undefined);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await store.load(id), saved);
  } finally { await reopened.closeSession(); }
  // 默认配置自身无效仍须报错，不能把所有初始化失败都当成旧历史问题。
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "unknown", defaultModel: "missing" }));
  await assert.rejects(sessionModule.createSessionService(path.join(root, "sessions"), create, () => workspace).listModels(), /Pi 未找到模型：unknown\/missing/);
}

if (scenario === "configuration") {
  await writeConfig({ alpha: provider("https://alpha.invalid/v1"), beta: provider("https://beta.invalid/v1") });
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "alpha", defaultModel: "same" }));
  const session = await service.getSession();
  try {
    assert.equal(session.model.provider, "alpha");
    const available = await service.listModels();
    assert.ok(available.models.some(m => m.provider === "alpha" && m.id === "same"));
    assert.ok(available.models.some(m => m.provider === "beta" && m.id === "same"));
    // 页面只拿到展示用的白名单字段，不传递完整 SDK 模型对象。
    const pageFields = ["api", "contextWindow", "cost", "id", "input", "maxTokens", "name", "provider", "reasoning", "thinkingLevelMap"];
    assert.ok(available.models.every(m => Object.keys(m).every(key => pageFields.includes(key))));
    assert.ok(available.models.every(m => m.id && m.provider && typeof m.reasoning === "boolean"));
    assert.ok(!JSON.stringify(available).includes(process.env.CUSTOM_TEST_KEY));
    assert.equal((await session.modelRuntime.getAuth(session.model)).auth.apiKey, process.env.CUSTOM_TEST_KEY);
    session.sessionManager.appendMessage({ role: "user", content: "本地历史", timestamp: Date.now() });
    await service.switchModel("same", "beta");
    const id = session.sessionId;
    await service.setDefaultModel();
    const settings = JSON.parse(await fs.readFile(settingsPath, "utf8"));
    assert.equal(settings.defaultProvider, "beta");
    assert.equal(settings.defaultModel, "same");
    await service.newChat();
    assert.equal((await service.getSession()).model.provider, "beta");
    await service.openSession(id);
    assert.equal((await service.getSession()).model.provider, "beta");
    await service.switchModel("same", "alpha");
    await service.newChat();
    await service.openSession(id);
    assert.equal((await service.getSession()).model.provider, "alpha");
    // 官方模型覆盖优先于 .env 的地址后备；启动值不覆盖已保存默认。
    await writeConfig({ alpha: provider("https://override.invalid/v1"), beta: provider("https://beta.invalid/v1") });
    const explicit = await createPiAgent(path.join(root, "fresh"), false, undefined, workspace,
      { provider: "alpha", modelId: "same", baseUrl: "https://environment.invalid/v1" });
    assert.equal(explicit.model.provider, "beta");
    assert.equal(explicit.modelRuntime.getModel("alpha", "same").baseUrl, "https://override.invalid/v1");
    await lifecycle.closePiSession(explicit);
  } finally { await service.closeSession(); }
}
if (scenario === "extension") {
  await fs.mkdir(path.join(agentDir, "extensions"));
  await fs.writeFile(path.join(agentDir, "extensions", "custom.js"), `export default async function(pi) {
    await Promise.resolve();
    pi.registerProvider("dynamic", { api: "openai-completions", baseUrl: "https://dynamic.invalid/v1", apiKey: "$CUSTOM_TEST_KEY",
      models: [{ id: "dynamic-model", name: "Dynamic", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 1024 }] });
  }`);
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "dynamic", defaultModel: "dynamic-model" }));
  const session = await service.getSession();
  try {
    assert.equal(session.model.provider, "dynamic");
    assert.equal(session.model.id, "dynamic-model");
    assert.ok((await service.listModels()).models.some(m => m.provider === "dynamic"));
    session.sessionManager.appendMessage({ role: "user", content: "本地历史", timestamp: Date.now() });
    const id = session.sessionId;
    await service.newChat();
    await service.openSession(id);
    assert.equal((await service.getSession()).model.provider, "dynamic");
  } finally { await service.closeSession(); }
}
if (scenario === "reload") {
  await writeConfig({ alpha: provider("https://before.invalid/v1") });
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "alpha", defaultModel: "same" }));
  const session = await service.getSession();
  try {
    const id = session.sessionId;
    await writeConfig({ alpha: provider("https://after.invalid/v1"), beta: provider("https://beta.invalid/v1") });
    const list = await service.reloadModels();
    assert.equal(session.sessionId, id);
    assert.equal(session.model.baseUrl, "https://after.invalid/v1");
    assert.ok(list.models.some(m => m.provider === "beta"));
    await fs.writeFile(configPath, '{"providers":{"private-test-value":');
    await assert.rejects(service.reloadModels(), error => !error.message.includes("private-test-value") && /模型配置加载失败/.test(error.message));
    await writeConfig({ beta: provider("https://beta.invalid/v1") });
    await service.reloadModels();
    await assert.rejects(sendMessage(session, "不应发送", () => {}, () => {}), /No API key|模型/);
    await service.switchModel("same", "beta");
    assert.equal(session.model.provider, "beta");
  } finally { await service.closeSession(); }
}
if (scenario === "stream") {
  let requests = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, `Bearer ${process.env.CUSTOM_TEST_KEY}`);
    const chunks = [];
    for await (const part of req) chunks.push(part);
    const body = JSON.parse(Buffer.concat(chunks));
    requests++;
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    const emit = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id: "fixture", object: "chat.completion.chunk", model: "same", choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
    emit({ role: "assistant" });
    if (body.messages.some(m => m.content === "CANCEL_TEST")) {
      emit({ content: "正在生成" });
      return;
    }
    if (!body.messages.some(m => m.role === "tool")) {
      emit({ tool_calls: [{ index: 0, id: "write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "provider-check.txt", content: "工具调用已验证" }) } }] });
      emit({}, "tool_calls");
    } else {
      emit({ content: "自定义供应商" });
      emit({ content: "流式回复通过。" });
      emit({}, "stop");
    }
    res.end("data: [DONE]\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await writeConfig({ local: provider(`http://127.0.0.1:${server.address().port}/v1`) });
  await fs.writeFile(settingsPath, JSON.stringify({ defaultProvider: "local", defaultModel: "same", retry: { enabled: false } }));
  const session = await service.getSession();
  try {
    const text = [], tools = [];
    await sendMessage(session, "请执行本地协议夹具", delta => text.push(delta), event => tools.push(event));
    assert.equal(text.join(""), "自定义供应商流式回复通过。");
    assert.equal(await fs.readFile(path.join(workspace, "provider-check.txt"), "utf8"), "工具调用已验证");
    assert.ok(tools.some(t => t.type === "end" && t.name === "write" && !t.isError));
    const stopping = sendMessage(session, "CANCEL_TEST", () => { void session.abort(); }, () => {});
    await assert.rejects(stopping, /aborted/i);
    assert.ok(requests >= 3);
    assert.equal(session.isStreaming, false);
    assert.equal(session.messages.at(-1).stopReason, "aborted");
  } finally {
    await service.closeSession();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
}
