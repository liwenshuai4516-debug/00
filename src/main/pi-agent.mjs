import { readFile } from "node:fs/promises";
import path from "node:path";
import {
  createAgentSession,
  ModelRuntime,
  parseSkillBlock,
} from "@mariozechner/pi-coding-agent";
import { createWorkspaceSession } from "./workspace/workspace-session.mjs";
import { createPiResources } from "./resources/pi-resources.mjs";
import sessionLifecycle from "./resources/pi-session-lifecycle.js";
import { AGENT_SYSTEM_PROMPT } from "./prompts/agent-system-prompt.mjs";
import { bindPromptDiagnostics, logInitialPrompt } from "./resources/prompt-diagnostics.mjs";
import messageAdapter from "./adapters/message-adapter.js";
import outputAdapter from "./adapters/output-event-adapter.js";
import modelConfig from "./config/model-config.js";
import requestStatus from "./adapters/request-status.js";
import { bindDesktopRuntime } from "./resources/desktop-session-runtime.mjs";
import { TEST_AGENT_PROMPT } from "./prompts/test-agent-prompt.mjs";
import { todoWriteTool } from "./tools/todo-write.mjs";
import { createSubagentManager, createSubagentExtension, createSubagentReplyExtension } from "./resources/subagents.mjs";

const { formatToolResult, toHistory } = messageAdapter;
const { createOutputEventAdapter } = outputAdapter;
const { readModelConfig } = modelConfig;
const { getRequestStatus } = requestStatus;

// sessionPath 用于打开指定历史会话。
export async function createPiAgent(
  sessionDir,
  resume = false,
  sessionPath,
  workspaceDir = process.env.AGENT_WORKSPACE_DIR,
  modelOptions,
  recovery,
  resumeOptions,
  promptOptions,
  resourceOptions,
) {
  let stageStarted = performance.now();
  function recordStage(stage) {
    const now = performance.now();
    const elapsed = Math.round(now - stageStarted);
    // 只记录慢步骤名称和耗时，不输出目录、配置、凭据或会话内容。
    if (elapsed >= 500) console.info(`[Pi 会话准备] ${stage}：${elapsed} ms`);
    stageStarted = now;
  }
  const startupModel = modelOptions ?? readModelConfig();

  // 目录检查、会话恢复和目录绑定统一交给新模块处理。
  const { workspaceRoot, sessionManager, source } =
    resourceOptions?.runtimeTarget ? {
      workspaceRoot: workspaceDir,
      sessionManager: resourceOptions.runtimeTarget.sessionManager,
      source: resourceOptions.runtimeTarget.sessionStartEvent?.reason === "new" ? "empty" : "history",
    } : await createWorkspaceSession({
      sessionDir,
      // 显式目录供后续选择入口使用；旧调用仍采用启动配置。
      workspaceDir,
      resume,
      sessionPath,
      recovery,
      archivedSessionIds: resumeOptions?.archivedSessionIds,
    });

  if (resourceOptions?.runtimeTarget) {
    // 官方 runtime 新建/分叉可能没有应用绑定；只给新目标补充元数据。
    const bindings = sessionManager.getEntries().filter(entry => entry.type === "custom" && entry.customType === "desktop-workspace-binding");
    if (bindings.length === 0) sessionManager.appendCustomEntry("desktop-workspace-binding", { version: 1, workspaceRoot });
  }

  let promptSnapshot = null;
  if (promptOptions !== undefined) {
    const { promptSettingsStore, sessionStateStore } = promptOptions;
    const sessionId = sessionManager.getSessionId();
    const savedState = await sessionStateStore.load(sessionId);
    if (savedState && savedState.workspaceDir !== workspaceRoot) {
      throw new Error("会话提示词状态不属于当前工作目录。");
    }

    promptSnapshot = savedState?.promptSnapshot;
    if (!promptSnapshot) {
      const defaults = resumeOptions?.promptSnapshot ?? await promptSettingsStore.read();
      const candidate = {
        ...defaults,
        // 恢复旧历史或旧空会话时，不能冒充已知其原提示词。
        origin:
          source === "history" || recovery !== undefined ? "legacy" : "new",
      };
      const stored = await sessionStateStore.update(
        sessionId,
        workspaceRoot,
        (state) => ({
          ...state,
          // 与输入、置顶和归档共用串行更新，不覆盖其他字段。
          promptSnapshot: state.promptSnapshot ?? candidate,
        }),
      );
      promptSnapshot = stored.promptSnapshot;
    }
  }

  recordStage("目录与会话状态");
  if (resumeOptions?.permissionSourceSessionId && resourceOptions?.permissionController?.save) {
    // 自动交接延续同一任务的权限，不回退到新对话默认，也不扩大原授权。
    const mode = resourceOptions.permissionController.currentMode({
      sessionId: resumeOptions.permissionSourceSessionId, workspace: workspaceRoot,
    });
    await resourceOptions.permissionController.save({
      mode, scope: "session", sessionId: sessionManager.getSessionId(), workspace: workspaceRoot,
    });
  }
  // 完全权限同时信任项目资源；只影响本次会话的加载决定，不写入 ProjectTrustStore。
  const permissionMode = resourceOptions?.subagentParent?.permissionMode ?? resourceOptions?.permissionController?.currentMode?.({
    sessionId: sessionManager.getSessionId?.(),
    workspace: workspaceRoot,
  }) ?? "ask";
  let parentSession;
  const subagents = resourceOptions?.subagentParent ? null : createSubagentManager({
    getParent: () => parentSession,
    createChild: (sessionManager, child) => createPiAgent(
      sessionManager.getSessionDir(), false, undefined, workspaceRoot, startupModel,
      undefined, undefined, undefined, {
        ...resourceOptions,
        runtimeTarget: { sessionManager, sessionStartEvent: { type: "session_start", reason: "resume" } },
        subagentParent: child,
        delegatedPrompt: promptSnapshot?.testAgentPrompt ?? resourceOptions?.delegatedPrompt,
        // 子级固定权限快照；无 UI 的 ask 模式按原门禁契约拒绝需要审批的操作。
        permissionController: { currentMode: () => child.permissionMode },
        askProjectTrust: async () => ({ trusted: parentSession.settingsManager.isProjectTrusted() }),
        createUiContext: undefined,
        uiTestingRuntime: undefined,
        workspaceChanges: undefined,
        onDiagnostics: async items => {
          if (items.some(item => item.type === "error")) throw new Error("子会话资源加载失败，请检查 Pi 扩展配置。");
        },
      },
    ),
  });
  // 每个会话独立持有运行时引用，探索复用此会话的官方模型和认证。
  const uiTestingRuntime = resourceOptions?.uiTestingRuntime ? { ...resourceOptions.uiTestingRuntime } : undefined;
  const { agentDir, settingsManager, resourceLoader, reportDiagnostics } =
    await createPiResources({
      cwd: workspaceRoot,
      systemPrompt: [promptSnapshot?.testAgentPrompt ?? resourceOptions?.delegatedPrompt ?? TEST_AGENT_PROMPT, AGENT_SYSTEM_PROMPT].join("\n\n"),
      askProjectTrust: resourceOptions?.askProjectTrust,
      onDiagnostics: resourceOptions?.onDiagnostics,
      uiTestingRuntime,
      permissionController: resourceOptions?.permissionController,
      permissionMode,
      workspaceChanges: resourceOptions?.workspaceChanges,
      subagentExtension: subagents ? createSubagentExtension(subagents, () => resourceOptions?.permissionController?.currentMode?.({
        sessionId: parentSession.sessionId, workspace: workspaceRoot,
      }) ?? "ask") : createSubagentReplyExtension(resourceOptions.subagentParent.sendToParent),
    });
  recordStage("资源与扩展发现（含项目信任）");

  // 仅真正重建的空会话采用登记模型；找到历史时仍遵循原分支选择。
  const savedSelection =
    source === "empty" && recovery !== undefined
      ? recovery.registration.model
      : (sessionManager
          .getBranch()
          .findLast((entry) => entry.type === "model_change") ??
        sessionManager.buildSessionContext().model);

  // 模型、凭据和 models.json 均由 Pi 官方运行时读取，不再建立应用配置档案。
  // 等后备配置和扩展供应商登记完成后统一刷新，避免初始化时重复检查整个目录。
  const runtime = await ModelRuntime.create({ refreshOnCreate: false });
  if (startupModel.apiKey) await runtime.setRuntimeApiKey(startupModel.provider, startupModel.apiKey);
  if (runtime.getError()) throw new Error("Pi 模型配置加载失败，请检查 models.json 和认证配置。");
  if (startupModel.baseUrl) {
    let providers = {};
    try {
      providers = JSON.parse(await readFile(path.join(agentDir, "models.json"), "utf8")).providers ?? {};
    } catch (error) {
      if (error.code !== "ENOENT") throw new Error("Pi 模型配置加载失败，请检查 models.json。");
    }
    // .env 仅作后备，不能覆盖用户已在官方配置中登记的供应商。
    if (!Object.hasOwn(providers, startupModel.provider)) runtime.registerProvider(startupModel.provider, { baseUrl: startupModel.baseUrl });
  }
  // SDK 在 AgentSession 构造时绑定扩展；先用公开登记 API 解析工厂排队的模型，避免启动时回退到其他模型。
  const extensions = resourceLoader.getExtensions().runtime;
  for (const { name, config } of extensions.pendingProviderRegistrations) runtime.registerProvider(name, config);
  for (const { provider } of extensions.pendingNativeProviderRegistrations) runtime.registerNativeProvider(provider);
  for (const { definition } of extensions.pendingVirtualModelRegistrations) runtime.registerVirtualModel(definition);
  await runtime.refresh({ allowNetwork: false });
  if (runtime.getError()) throw new Error("Pi 模型配置加载失败，请检查 models.json 和 Provider 扩展。");
  const defaultProvider = settingsManager.getDefaultProvider();
  const defaultModel = settingsManager.getDefaultModel();
  const selection = savedSelection ?? resumeOptions?.modelSelection ?? (defaultProvider && defaultModel
    ? { provider: defaultProvider, modelId: defaultModel }
    : startupModel.provider && startupModel.modelId ? startupModel : undefined);
  const model = selection ? runtime.getModel(selection.provider, selection.modelId) : undefined;
  if (selection && !model) {
    const error = new Error(`Pi 未找到模型：${selection.provider}/${selection.modelId}。请检查 models.json 或 Provider 扩展，或新建对话。`);
    if (savedSelection) error.code = "PI_SAVED_MODEL_UNAVAILABLE";
    throw error;
  }
  if (uiTestingRuntime) uiTestingRuntime.modelRuntime = runtime;
  recordStage("模型目录与认证");

  // 不传 tools/excludeTools：沿用 Pi 的默认工具及 defaultTools 配置。
  // customTools 只追加注册，不会替换原生工具；任务清单由页面任务栏读取工具结果。
  const { session } = await createAgentSession({
    customTools: [todoWriteTool],
    cwd: workspaceRoot,
    agentDir,
    modelRuntime: runtime,
    model,
    settingsManager,
    resourceLoader,
    sessionManager,
    sessionStartEvent: resourceOptions?.runtimeTarget?.sessionStartEvent,
    ...(resumeOptions?.thinkingLevel ? { thinkingLevel: resumeOptions.thinkingLevel } : {}),
    ...(resourceOptions?.subagentParent ? { thinkingLevel: resourceOptions.subagentParent.thinkingLevel } : {}),
  });
  bindPromptDiagnostics(session, { knownSecrets: [startupModel.apiKey] });
  // 扩展命令替换会话时由 runtime 在绑定完成后调用，与普通创建保持同一时机。
  session.desktopLogInitialPrompt = () => logInitialPrompt(session, {
    agentDir,
    knownSecrets: [startupModel.apiKey],
    role: resourceOptions?.subagentParent ? "subagent" : "main",
  });
  parentSession = session;
  session.desktopSubagents = subagents;
  session.desktopReloadResources = async () => {
    session.desktopResourceDiagnostics = [];
    await session.reload();
    session.desktopResourceDiagnostics.push(...await reportDiagnostics());
  };
  session.desktopReportDiagnostics = reportDiagnostics;
  session.desktopServices = { cwd: workspaceRoot, agentDir, settingsManager, modelRuntime: runtime, resourceLoader, diagnostics: [] };
  session.desktopParseSkillBlock = parseSkillBlock;
  session.desktopOnExtensionError = (error) => {
    const diagnostic = { type: "error", path: error.extensionPath, message: `${error.event}: ${error.error}` };
    session.desktopResourceDiagnostics ??= [];
    session.desktopResourceDiagnostics.push(diagnostic);
    Promise.resolve().then(() => resourceOptions?.onDiagnostics?.([diagnostic])).catch(() => {
      console.error("Pi 扩展错误提示未能展示。");
    });
  };
  session.desktopCancelUi = () => (resourceOptions?.cancelPendingUi ?? resourceOptions?.cancelUi)?.(session.sessionId);
  session.desktopClearUi = () => resourceOptions?.cancelUi?.(session.sessionId);

  // 仅记录创建时的可信来源；后续产生消息时仍需推进持久化登记。
  session.desktopSessionOrigin = source;
  // 只在主进程保留本会话的实际快照，页面通过专用接口读取必要字段。
  if (promptSnapshot) session.desktopPromptSnapshot = promptSnapshot;

  if (resourceOptions?.subagentParent) {
    try {
      await session.bindExtensions({ mode: "json", onError: error => {
        session.desktopSubagentError = new Error(`子会话扩展错误：${error.error}`);
        void session.abort();
      } });
      session.desktopResourceDiagnostics = await reportDiagnostics();
      if (session.desktopSubagentError) throw session.desktopSubagentError;
    } catch (error) {
      await sessionLifecycle.closePiSession(session);
      throw error;
    }
  }

  if (!resourceOptions?.runtimeTarget) {
    try {
      await bindDesktopRuntime(session, (target) => createPiAgent(
        sessionDir, false, undefined, target.cwd, modelOptions, undefined, undefined,
        promptOptions, { ...resourceOptions, runtimeTarget: target },
      ), resourceOptions);
    } catch (error) {
      await sessionLifecycle.closePiSession(session);
      throw error;
    }
  }
  recordStage("会话与扩展启动");
  // 子会话自行完成绑定；主会话的初始日志由 desktop runtime 统一记录。
  if (resourceOptions?.subagentParent) session.desktopLogInitialPrompt();
  return session;
}

// 列出当前会话可用的资源命令，来源与 Pi 官方命令菜单一致。
// 桌面内置命令由渲染层补充，避免重复登记。
export function listSlashCommands(session) {
  const commands = [];

  for (const command of session.extensionRunner?.getRegisteredCommands?.() ?? []) {
    commands.push({
      name: command.invocationName,
      description: command.description ?? "",
      source: "extension",
    });
  }

  for (const template of session.promptTemplates ?? []) {
    commands.push({
      name: template.name,
      description: template.description ?? "",
      ...(template.argumentHint ? { argumentHint: template.argumentHint } : {}),
      source: "prompt",
    });
  }

  // 技能命令由 SDK 在发送时展开，这里只提供名称和说明。
  for (const skill of session.resourceLoader?.getSkills?.().skills ?? []) {
    commands.push({
      name: `skill:${skill.name}`,
      description: skill.description ?? "",
      source: "skill",
    });
  }

  return commands;
}

// 发送消息，并把收到的文本增量交给调用方。
// 生成中的插话：使用 Pi 的 steer 语义，在当前轮工具结束后、下一次请求前投递。
export async function steerMessage(session, text) {
  if (session?.desktopRuntimeInvalidated) throw new Error("当前 Pi 会话已释放，请新建或重新打开对话。");
  if (typeof text !== "string" || text.trim() === "") throw new Error("请输入插话内容。");
  if (!session?.isStreaming) throw new Error("当前没有正在生成的回复。");
  let disposition;
  await session.prompt(text.trim(), {
    streamingBehavior: "steer",
    preflightResult: (result) => { disposition = result; },
  });
  return { disposition };
}

export async function sendMessage(
  session,
  text,
  onText,
  onToolEvent,
  onStatus = () => {},
  onOutputEvent = () => {},
) {
  if (session.desktopRuntimeInvalidated) throw new Error("当前 Pi 会话已释放，请新建或重新打开对话。");
  let observed = session;
  const requestSessionId = session.sessionId;
  const projectOutput = createOutputEventAdapter(() => observed, parseSkillBlock, text);
  const receive = (event) => {
    const output = projectOutput(event);
    if (output) onOutputEvent({ requestSessionId, sessionId: observed.sessionId, ...output });
    // 生命周期状态独立展示，不混入正文或工具结果。
    const status = getRequestStatus(event);
    if (status) onStatus(status);
    if (event.type === "message_end" && event.message.role === "custom" && event.message.display === true) {
      onToolEvent({ type: "message", text: toHistory([event.message])[0]?.text ?? "" });
    }
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
  };
  let unsubscribe = session.subscribe(receive);
  let finishUiStatus;
  const rebind = (next) => {
    finishUiStatus?.();
    finishUiStatus = undefined;
    unsubscribe();
    observed = next;
    unsubscribe = next.subscribe(receive);
  };
  session.desktopRuntimeListeners?.add(rebind);

  try {
    // CLI 的 /reload 属于宿主命令；走现有发送互斥，不请求模型。
    if (text.trim() === "/reload") {
      await session.desktopReloadResources();
      const completionStatus = "Pi 资源已重新加载。";
      onStatus(completionStatus);
      return { completionStatus };
    }
    let disposition;
    finishUiStatus = session.desktopBeginUiStatus?.();
    await session.prompt(text, {
      preflightResult: (result) => { disposition = result; },
    });

    // 扩展消费命令时没有新推理，不能把上次模型错误算到本次命令。
    if (disposition === "started" && session.agent.state.errorMessage) {
      throw new Error(session.agent.state.errorMessage);
    }
  } finally {
    finishUiStatus?.();
    // 请求结束后取消订阅，防止下一次重复接收。
    unsubscribe();
    session.desktopRuntimeListeners?.delete(rebind);
  }
}
