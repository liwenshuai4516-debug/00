import {
  createAgentSession,
  ModelRuntime,
} from "@mariozechner/pi-coding-agent";
import { createWorkspaceSession } from "./workspace/workspace-session.mjs";
import { createPiResources } from "./resources/pi-resources.mjs";
import sessionLifecycle from "./resources/pi-session-lifecycle.js";
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
  recovery,
  resumeOptions,
  promptOptions,
  resourceOptions,
) {
  const managed = typeof modelSettings?.resolveSelection === "function";
  // 保留原四参数和旧配置对象调用，独立初始化检查仍在创建目录前校验。
  const legacyConfig = managed ? null : (modelSettings ?? readModelConfig());

  // 目录检查、会话恢复和目录绑定统一交给新模块处理。
  const { workspaceRoot, sessionManager, source } = await createWorkspaceSession({
    sessionDir,
    // 显式目录供后续选择入口使用；旧调用仍采用启动配置。
    workspaceDir,
    resume,
    sessionPath,
    recovery,
    archivedSessionIds: resumeOptions?.archivedSessionIds,
  });

  const { agentDir, settingsManager, resourceLoader, reportDiagnostics } =
    await createPiResources({
      cwd: workspaceRoot,
      appendSystemPrompt: [AGENT_SYSTEM_PROMPT],
      askProjectTrust: resourceOptions?.askProjectTrust,
      onDiagnostics: resourceOptions?.onDiagnostics,
    });

  // 仅真正重建的空会话采用登记模型；找到历史时仍遵循原分支选择。
  const savedSelection = source === "empty" && recovery !== undefined
    ? recovery.registration.model
    : sessionManager.getBranch().findLast((entry) => entry.type === "model_change") ??
      sessionManager.buildSessionContext().model;
  const runtime = managed && modelSettings.createRuntime
    ? await modelSettings.createRuntime() : await ModelRuntime.create();
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

  // 不传 tools/customTools：沿用 Pi 的默认工具及 defaultTools 配置。
  const { session } = await createAgentSession({
    cwd: workspaceRoot,
    agentDir,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager,
  });

  session.desktopReloadResources = async () => {
    session.desktopResourceDiagnostics = [];
    await session.reload();
    session.desktopResourceDiagnostics.push(...await reportDiagnostics());
  };
  try {
    await session.bindExtensions({
      // 使用 SDK 的非终端模式，不把终端组件冒充桌面组件。
      mode: "json",
      commandContextActions: { reload: session.desktopReloadResources },
      shutdownHandler: resourceOptions?.shutdown,
      onError: (error) => {
        const diagnostic = { type: "error", path: error.extensionPath, message: `${error.event}: ${error.error}` };
        session.desktopResourceDiagnostics ??= [];
        session.desktopResourceDiagnostics.push(diagnostic);
        Promise.resolve().then(() => resourceOptions?.onDiagnostics?.([diagnostic])).catch(() => {
          console.error("Pi 扩展错误提示未能展示。");
        });
      },
    });
    session.desktopResourceDiagnostics = [
      ...(session.desktopResourceDiagnostics ?? []),
      ...await reportDiagnostics(),
    ];
  } catch (error) {
    await sessionLifecycle.closePiSession(session);
    throw error;
  }

  // 仅记录创建时的可信来源；后续产生消息时仍需推进持久化登记。
  session.desktopSessionOrigin = source;

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
    // CLI 的 /reload 属于宿主命令；走现有发送互斥，不请求模型。
    if (text.trim() === "/reload") {
      await session.desktopReloadResources();
      onStatus("Pi 资源已重新加载。");
      return;
    }
    let disposition;
    await session.prompt(text, {
      preflightResult: (result) => { disposition = result; },
    });

    // 扩展消费命令时没有新推理，不能把上次模型错误算到本次命令。
    if (disposition === "started" && session.agent.state.errorMessage) {
      throw new Error(session.agent.state.errorMessage);
    }
  } finally {
    // 请求结束后取消订阅，防止下一次重复接收。
    unsubscribe();
  }
}
