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
  modelSettings,
) {
  const managed = typeof modelSettings?.resolveSelection === "function";
  // 保留原四参数和旧配置对象调用，独立初始化检查仍在创建目录前校验。
  const legacyConfig = managed ? null : (modelSettings ?? readModelConfig());

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

  const savedSelection = sessionManager.getBranch().findLast(
    (entry) => entry.type === "model_change",
  ) ?? sessionManager.buildSessionContext().model;
  const runtime = await ModelRuntime.create();
  let model;
  if (managed) {
    const profile = await modelSettings.resolveSelection(savedSelection);
    const { installModelProfile } = await import("./model-profile-runtime.mjs");
    model = await installModelProfile(runtime, profile);
  } else {
    const { provider, modelId, baseUrl, apiKey } = legacyConfig;
    if (apiKey) await runtime.setRuntimeApiKey(provider, apiKey);
    if (baseUrl) runtime.registerProvider(provider, { baseUrl });
    if (savedSelection && savedSelection.provider !== provider) {
      throw new Error("会话模型属于其他供应商，请恢复对应供应商配置或新建对话。");
    }
    const selectedModelId = savedSelection?.modelId ?? modelId;
    model = runtime.getModel(provider, selectedModelId);
    if (!model) throw new Error(`Pi 未找到模型：${provider}/${selectedModelId}。`);
  }

  // 工具、模型上下文和会话使用同一个真实工作目录。
  const agentTools = createAgentTools(workspaceRoot);

  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader,
    tools: agentTools.map((tool) => tool.name),
    customTools: agentTools,
    sessionManager,
  });

  // 仅主进程持有配置服务；不把密钥或服务对象返回页面。
  if (managed) session.desktopModelSettings = modelSettings;
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
