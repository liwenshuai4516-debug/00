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

// SDK 没有导出 CLI 的信任决策函数；按公开事件契约接上宿主交互。
async function resolveTrust({ cwd, agentDir, settingsManager, extensionsResult, ask, diagnostics }) {
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
    for (const handler of [...(extension.handlers.get("project_trust") ?? [])]) {
      try {
        const result = await handler({ type: "project_trust", cwd }, context);
        if (result.trusted === "undecided") continue;
        const trusted = result.trusted === "yes";
        if (result.remember === true) store.set(cwd, trusted);
        return trusted;
      } catch (error) {
        diagnostics.push({ type: "warning", path: extension.path, message: `project_trust: ${error.message}` });
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

export async function createPiResources({ cwd, appendSystemPrompt, askProjectTrust, onDiagnostics }) {
  // 与内置 MCP 等扩展统一使用官方目录；环境变量仍可覆盖其位置。
  const agentDir = getAgentDir();
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  const trustDiagnostics = [];
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    // 保留 APPEND_SYSTEM.md 的官方发现，再追加宿主说明。
    appendSystemPromptOverride: (base) => [...base, ...(appendSystemPrompt ?? [])],
    // 采用官方内置扩展身份，保留配置禁用与第三方替换语义。
    extensionFactories: [
      { name: "codemode", factory: createCodemodeExtension(), builtin: true, replaceable: true },
      { name: "tool-search", factory: createToolSearchExtension(), builtin: true, replaceable: true },
      { name: "mcp", factory: createMcpExtension(), builtin: true, replaceable: true },
    ],
  });
  await resourceLoader.reload({
    resolveProjectTrust: ({ extensionsResult }) => resolveTrust({
      cwd, agentDir, settingsManager, extensionsResult,
      ask: askProjectTrust, diagnostics: trustDiagnostics,
    }),
  });

  async function reportDiagnostics() {
    const extensions = resourceLoader.getExtensions();
    const diagnostics = [
      ...trustDiagnostics.splice(0),
      ...settingsManager.drainErrors().map(({ scope, error }) => ({
        type: "warning", message: `${scope} settings: ${error.message}`,
      })),
      ...resourceLoader.getSkills().diagnostics,
      ...resourceLoader.getPrompts().diagnostics,
      ...resourceLoader.getThemes().diagnostics,
      ...extensions.errors.map(({ path, error }) => ({ type: "error", path, message: error })),
      ...(extensions.warnings ?? []).map(({ path, warning }) => ({ type: "warning", path, message: warning })),
    ];
    if (diagnostics.length > 0) await onDiagnostics?.(diagnostics);
    return diagnostics;
  }

  return { agentDir, settingsManager, resourceLoader, reportDiagnostics };
}
