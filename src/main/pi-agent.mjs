import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  ModelRuntime,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createWorkspaceSession } from "./workspace/workspace-session.mjs";
import { createAgentTools } from "./tools/index.mjs";
import { AGENT_SYSTEM_PROMPT } from "./prompts/agent-system-prompt.mjs";
import messageAdapter from "./adapters/message-adapter.js";
import modelConfig from "./config/model-config.js";
import requestStatus from "./adapters/request-status.js";

const { formatToolResult } = messageAdapter;
const { readModelConfig } = modelConfig;
const { getRequestStatus } = requestStatus;

// sessionPath 用于打开指定历史会话。
export async function createPiAgent(
  sessionDir,
  resume = false,
  sessionPath,
  workspaceDir = process.env.AGENT_WORKSPACE_DIR,
) {
  // 先校验配置，再创建会话、加载资源或初始化认证存储。
  const { provider, modelId, baseUrl } = readModelConfig();

  // 目录检查、会话恢复和目录绑定统一交给新模块处理。
  const { workspaceRoot, sessionManager } = await createWorkspaceSession({
    sessionDir,
    // 显式目录供后续选择入口使用；旧调用仍采用启动配置。
    workspaceDir,
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

  // Pi 1.4 使用统一的异步模型与凭据运行时。
  const modelRuntime = await ModelRuntime.create();

  if (baseUrl) {
    modelRuntime.registerProvider(provider, { baseUrl });
  }

  // 优先采用当前分支最后一次明确的模型选择。
  // 旧会话没有 model_change 时，兼容 SDK 从历史消息解析的模型。
  const savedSelection =
    sessionManager
      .getBranch()
      .findLast((entry) => entry.type === "model_change") ??
    sessionManager.buildSessionContext().model;

  // 当前版本只支持配置中的供应商，避免套用其他供应商的地址或凭据。
  if (savedSelection && savedSelection.provider !== provider) {
    throw new Error("会话模型属于其他供应商，请恢复对应供应商配置或新建对话。");
  }

  // 没有历史选择的新会话使用 .env 默认值。
  const selectedModelId = savedSelection?.modelId ?? modelId;
  const model = modelRuntime.getModel(provider, selectedModelId);

  if (!model) {
    throw new Error(`Pi 未找到模型：${provider}/${selectedModelId}。`);
  }

  // 工具、模型上下文和会话使用同一个真实工作目录。
  const agentTools = createAgentTools(workspaceRoot);

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    modelRuntime,
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
export async function sendMessage(
  session,
  text,
  onText,
  onToolEvent,
  onStatus = () => {},
) {
  const unsubscribe = session.subscribe((event) => {
    // 生命周期状态独立展示，不混入正文或工具结果。
    const status = getRequestStatus(event);
    if (status) onStatus(status);
    // 将工具开始和结束事件交给主进程。
    if (event.type === "tool_execution_start") {
      onToolEvent({
        type: "start",
        toolCallId: event.toolCallId,
        name: event.toolName,
      });
    }

    if (event.type === "tool_execution_end") {
      const toolEvent = {
        type: "end",
        toolCallId: event.toolCallId,
        name: event.toolName,
        isError: event.isError,
        text: formatToolResult(
          event.toolName,
          event.result.content,
          event.isError,
        ),
      };

      // 工具名称与草稿类型必须对应，失败结果不提取草稿。
      if (
        !event.isError &&
        ((event.toolName === "propose_workspace_edit" &&
          event.result.details?.kind === "edit-proposal") ||
          (event.toolName === "propose_workspace_create" &&
            event.result.details?.kind === "create-proposal"))
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
