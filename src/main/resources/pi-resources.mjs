import {
  createCodemodeExtension,
  createMcpExtension,
  createToolSearchExtension,
  DefaultResourceLoader,
  getAgentDir,
  hasTrustRequiringProjectResources,
  ProjectTrustStore,
  SettingsManager,
} from "@mariozechner/pi-coding-agent";
import { createUiTestingExtension } from "../capabilities/ui-testing/extension.mjs";
import { createPermissionExtension } from "./permission-gate.mjs";
import { createWorkspaceChangesExtension } from "./workspace-changes-extension.mjs";

// SDK 没有导出 CLI 的信任决策函数；按公开事件契约接上宿主交互。
// 完全权限代表用户已信任当前任务，项目资源直接加载；不写 ProjectTrustStore，
// 避免切换回安全模式后项目仍被静默记住为已信任。
export function shouldAutoTrustProject(permissionMode) {
  return permissionMode === "full-access";
}

async function resolveTrust({
  cwd,
  agentDir,
  settingsManager,
  extensionsResult,
  ask,
  diagnostics,
  permissionMode,
}) {
  if (shouldAutoTrustProject(permissionMode)) return true;
  if (!hasTrustRequiringProjectResources(cwd)) return true;
  const store = new ProjectTrustStore(agentDir);
  const context = {
    cwd,
    mode: "json",
    hasUI: false,
    ui: {
      select: async () => undefined,
      confirm: async () => false,
      input: async () => undefined,
      notify: (message) => diagnostics.push({ type: "warning", message }),
    },
  };

  // 与 Pi 顺序一致：用户扩展事件优先，其次最近的保存决定和默认策略。
  for (const extension of extensionsResult.extensions) {
    for (const handler of [
      ...(extension.handlers.get("project_trust") ?? []),
    ]) {
      try {
        const result = await handler({ type: "project_trust", cwd }, context);
        if (result.trusted === "undecided") continue;
        const trusted = result.trusted === "yes";
        if (result.remember === true) store.set(cwd, trusted);
        return trusted;
      } catch (error) {
        diagnostics.push({
          type: "warning",
          path: extension.path,
          message: `project_trust: ${error.message}`,
        });
      }
    }
  }
  const saved = store.get(cwd);
  if (saved !== null) return saved;
  const policy = settingsManager.getDefaultProjectTrust();
  if (policy === "always") return true;
  if (policy === "never") return false;
  const answer = await ask?.(cwd);
  const trusted = answer?.trusted === true;
  if (answer?.remember === true) store.set(cwd, trusted);
  return trusted;
}

// UI 测试扩展用 registerMcpServer 注册官方录制工具，依赖内置 MCP 的 direct 暴露。
// pi-mcp-adapter 会把运行时注册降级为 proxy-only，工具名不会以 mcp__<server>__<tool> 出现；
// 因此只在带 UI 测试运行时的会话中移除适配器并重新启用内置 MCP，不改用户的全局设置文件。
export function enableBuiltinMcpForUiTesting(settingsManager) {
  // 包管理器直接读 getGlobalSettings()/getProjectSettings()，applyOverrides 只影响 getSettings()，
  // 且 reload 会重读文件。这里在读取层过滤：UI 测试会话不加载 proxy-only 适配器，
  // 并去掉 -builtin:mcp，让官方 registerMcpServer 的 direct 工具正常登记。
  const marker = Symbol.for("dsh.uiTestingMcpFilterPatched");
  if (settingsManager[marker]) return false;
  settingsManager[marker] = true;

  const filter = (settings) => {
    const extensions = (settings.extensions ?? []).filter((entry) => entry !== "-builtin:mcp");
    const packages = (settings.packages ?? []).filter((entry) => !String(entry).includes("pi-mcp-adapter"));
    return {
      ...settings,
      extensions,
      packages,
    };
  };

  const changed = (() => {
    const current = settingsManager.getSettings();
    const next = filter(current);
    return next.extensions.length !== (current.extensions ?? []).length ||
      next.packages.length !== (current.packages ?? []).length;
  })();
  const readGlobal = settingsManager.getGlobalSettings.bind(settingsManager);
  const readProject = settingsManager.getProjectSettings.bind(settingsManager);
  const readEffective = settingsManager.getSettings.bind(settingsManager);
  settingsManager.getGlobalSettings = () => filter(readGlobal());
  settingsManager.getProjectSettings = () => filter(readProject());
  settingsManager.getSettings = () => filter(readEffective());
  return changed;
}

export async function createPiResources({
  cwd,
  appendSystemPrompt,
  askProjectTrust,
  onDiagnostics,
  uiTestingRuntime,
  permissionController,
  permissionMode,
  workspaceChanges,
  subagentExtension,
}) {
  // 与内置 MCP 等扩展统一使用官方目录；环境变量仍可覆盖其位置。
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, {
    projectTrusted: false,
  });
  if (uiTestingRuntime) enableBuiltinMcpForUiTesting(settingsManager);
  const trustDiagnostics = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // 保留 APPEND_SYSTEM.md 的官方发现，再追加宿主说明。
    appendSystemPromptOverride: (base) => [
      ...base,
      ...(appendSystemPrompt ?? []),
    ],
    // 采用官方内置扩展身份，保留配置禁用与第三方替换语义。
    extensionFactories: [
      ...(subagentExtension ? [{ name: "desktop-subagents", factory: subagentExtension, builtin: true, replaceable: true }] : []),
      {
        name: "codemode",
        factory: createCodemodeExtension(),
        builtin: true,
        replaceable: true,
      },
      {
        name: "tool-search",
        factory: createToolSearchExtension(),
        builtin: true,
        replaceable: true,
      },
      {
        name: "mcp",
        factory: createMcpExtension(),
        builtin: true,
        replaceable: true,
      },
      ...(uiTestingRuntime
        ? [
            {
              name: "desktop-ui-testing",
              factory: createUiTestingExtension(uiTestingRuntime),
              builtin: true,
              replaceable: true,
            },
          ]
        : []),
      ...(permissionController
        ? [
            {
              name: "desktop-permission-gate",
              factory: createPermissionExtension(permissionController),
              builtin: true,
              replaceable: true,
            },
          ]
        : []),
      ...(workspaceChanges
        ? [
            {
              name: "desktop-workspace-changes",
              factory: createWorkspaceChangesExtension(workspaceChanges),
              builtin: true,
              replaceable: true,
            },
          ]
        : []),
    ],
  });
  await resourceLoader.reload({
    resolveProjectTrust: ({ extensionsResult }) =>
      resolveTrust({
        cwd,
        agentDir,
        settingsManager,
        extensionsResult,
        ask: askProjectTrust,
        diagnostics: trustDiagnostics,
        permissionMode,
      }),
  });

  async function reportDiagnostics() {
    const extensions = resourceLoader.getExtensions();
    const diagnostics = [
      ...trustDiagnostics.splice(0),
      ...settingsManager.drainErrors().map(({ scope, error }) => ({
        type: "warning",
        message: `${scope} settings: ${error.message}`,
      })),
      ...resourceLoader.getSkills().diagnostics,
      ...resourceLoader.getPrompts().diagnostics,
      ...resourceLoader.getThemes().diagnostics,
      ...extensions.errors.map(({ path, error }) => ({
        type: "error",
        path,
        message: error,
      })),
      ...(extensions.warnings ?? []).map(({ path, warning }) => ({
        type: "warning",
        path,
        message: warning,
      })),
    ];
    if (diagnostics.length > 0) await onDiagnostics?.(diagnostics);
    return diagnostics;
  }

  return { agentDir, settingsManager, resourceLoader, reportDiagnostics };
}
