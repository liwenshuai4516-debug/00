import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";

// 使用内存配置，避免读取已配置的 Pi 扩展包。
const settingsManager = SettingsManager.inMemory();

// 本次只验证模型连接，暂时不加载扩展、技能和上下文文件。
const resourceLoader = new DefaultResourceLoader({
  cwd: process.cwd(),
  agentDir: getAgentDir(),
  settingsManager,
  noExtensions: true,
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
});

console.log("正在加载 Pi 资源...");
await resourceLoader.reload();

// 创建凭据管理器和模型注册表。
const authStorage = AuthStorage.create();
const modelRegistry = ModelRegistry.create(authStorage);

// 从 .env 读取模型提供商和模型名称。
const provider = process.env.PI_PROVIDER;
const modelId = process.env.PI_MODEL;
const baseUrl = process.env.PI_BASE_URL;


if (!provider || !modelId) {
  throw new Error("请在 .env 中配置 PI_PROVIDER 和 PI_MODEL。");
}
// 如果配置了地址，就覆盖该供应商的默认 API 地址。
if (baseUrl) {
  modelRegistry.registerProvider(provider, { baseUrl });
}

// 按供应商和模型名称精确查找。
const model = modelRegistry.find(provider, modelId);

if (!model) {
  throw new Error(`Pi 未找到模型：${provider}/${modelId}。`);
}


console.log(`使用模型：${model.provider}/${model.id}`);
console.log("正在创建会话...");

// 会话只保存在内存中，并且不启用内置工具。
const { session } = await createAgentSession({
  authStorage,
  modelRegistry,
  model,
  settingsManager,
  resourceLoader,
  tools: [],
  sessionManager: SessionManager.inMemory(),
});

// 订阅模型返回的文本，逐段输出。
const unsubscribe = session.subscribe((event) => {
  
  if (
    event.type === "message_update" &&
    event.assistantMessageEvent.type === "text_delta"
  ) {
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

try {
  console.log("正在请求模型...");

  await session.prompt("你好，请用一句话介绍你自己。");

  if (session.agent.state.errorMessage) {
    throw new Error(session.agent.state.errorMessage);
  }

  console.log("\n请求完成。");
} finally {
  unsubscribe();
  session.dispose();
}
