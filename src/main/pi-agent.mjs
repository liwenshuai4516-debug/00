import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  defineTool,
  SessionManager,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

// 定义一个不需要参数的工具，让模型获取当前北京时间。
const currentTimeTool = defineTool({
  name: "get_current_time",
  label: "获取当前时间",
  description: "获取当前北京时间，回答用户询问当前日期或时间的问题。",
  parameters: Type.Object({}),

  async execute() {
    // 在本机计算时间，明确指定时区。
    const time = new Intl.DateTimeFormat("zh-CN", {
      timeZone: "Asia/Shanghai",
      dateStyle: "full",
      timeStyle: "long",
    }).format(new Date());

    // 在启动应用的终端打印，方便确认工具确实被调用。
    console.log("工具调用：get_current_time");

    return {
      content: [{ type: "text", text: time }],
      details: {},
    };
  },
});
// sessionPath 用于打开指定历史会话。
export async function createPiAgent(sessionDir, resume = false, sessionPath) {
  const settingsManager = SettingsManager.inMemory();

  // 暂时不加载扩展、技能和项目上下文。
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

  await resourceLoader.reload();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  // 模型配置由 Electron 主进程加载的 .env 提供。
  const provider = process.env.PI_PROVIDER;
  const modelId = process.env.PI_MODEL;
  const baseUrl = process.env.PI_BASE_URL;

  if (!provider || !modelId) {
    throw new Error("请在 .env 中配置 PI_PROVIDER 和 PI_MODEL。");
  }

  if (baseUrl) {
    modelRegistry.registerProvider(provider, { baseUrl });
  }

  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    throw new Error(`Pi 未找到模型：${provider}/${modelId}。`);
  }

  const { session } = await createAgentSession({
    authStorage,
    modelRegistry,
    model,
    settingsManager,
    resourceLoader,
    // 只允许当前时间工具，暂不启用文件或命令工具。
    tools: ["get_current_time"],
    customTools: [currentTimeTool],
    // 指定路径时打开历史会话；否则恢复最近会话或创建新会话。
    sessionManager: sessionPath
      ? SessionManager.open(sessionPath)
      : resume
        ? SessionManager.continueRecent(process.cwd(), sessionDir)
        : SessionManager.create(process.cwd(), sessionDir),
  });

  return session;
}

// 发送消息，并把收到的文本增量交给调用方。
export async function sendMessage(session, text, onText) {
  const unsubscribe = session.subscribe((event) => {
    if (
      event.type === "message_update" &&
      event.assistantMessageEvent.type === "text_delta"
    ) {
      // 每收到一段文本，就立即通知主进程。
      onText(event.assistantMessageEvent.delta);
    }
  });

  try {
    await session.prompt(text);

    if (session.agent.state.errorMessage) {
      throw new Error(session.agent.state.errorMessage);
    }
  } finally {
    // 请求结束后取消订阅，防止下一次重复接收。
    unsubscribe();
  }
}
