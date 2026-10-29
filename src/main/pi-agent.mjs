import {
  AuthStorage,
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRegistry,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createWorkspaceSession } from "./workspace/workspace-session.mjs";
import { createAgentTools } from "./tools/index.mjs";
import { AGENT_SYSTEM_PROMPT } from "./prompts/agent-system-prompt.mjs";
import messageAdapter from "./adapters/message-adapter.js";
import modelConfig from "./config/model-config.js";

const { formatToolResult } = messageAdapter;
const { readModelConfig } = modelConfig;

// sessionPath 用于打开指定历史会话。
export async function createPiAgent(
  sessionDir,
  resume = false,
  sessionPath,
) {

    // 先校验配置，再创建会话、加载资源或初始化认证存储。
  const { provider, modelId, baseUrl } = readModelConfig();

  // 目录检查、会话恢复和目录绑定统一交给新模块处理。
  const {
    workspaceRoot,
    sessionManager,
  } = await createWorkspaceSession({
    sessionDir,
    workspaceDir: process.env.AGENT_WORKSPACE_DIR,
    resume,
    sessionPath,
  });

  const settingsManager = SettingsManager.inMemory();

  const resourceLoader = new DefaultResourceLoader({
    cwd: workspaceRoot,
    agentDir: getAgentDir(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: AGENT_SYSTEM_PROMPT,
    appendSystemPrompt: [],
  });

  await resourceLoader.reload();

  const authStorage = AuthStorage.create();
  const modelRegistry = ModelRegistry.create(authStorage);

  if (baseUrl) {
    modelRegistry.registerProvider(provider, { baseUrl });
  }

  const model = modelRegistry.find(provider, modelId);

  if (!model) {
    throw new Error(`Pi 未找到模型：${provider}/${modelId}。`);
  }

  // 工具、模型上下文和会话使用同一个真实工作目录。
  const agentTools = createAgentTools(workspaceRoot);

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    authStorage,
    modelRegistry,
    model,
    settingsManager,
    resourceLoader,
    tools: agentTools.map((tool) => tool.name),
    customTools: agentTools,
    sessionManager,
  });

  return session;
}

// 发送消息，并把收到的文本增量交给调用方。
export async function sendMessage(session, text, onText, onToolEvent) {
  const unsubscribe = session.subscribe((event) => {
    // 将工具开始和结束事件交给主进程。
    if (event.type === "tool_execution_start") {
      onToolEvent({ type: "start", name: event.toolName });
    }

    if (event.type === "tool_execution_end") {
      const toolEvent = {
        type: "end",
        name: event.toolName,
        isError: event.isError,
        text: formatToolResult(
          event.toolName,
          event.result.content,
          event.isError,
        ),
      };

      // 只从成功的草稿工具结果中提取结构化数据。
      if (
        event.toolName === "propose_workspace_edit" &&
        !event.isError &&
        event.result.details?.kind === "edit-proposal"
      ) {
        toolEvent.proposal = event.result.details;
      }

      onToolEvent(toolEvent);
    }

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
