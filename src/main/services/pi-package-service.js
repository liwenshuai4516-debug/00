function createPiPackageService(sessionService, createManager) {
  async function context() {
    const session = await sessionService.getSession(true);
    const { DefaultPackageManager } = await import("@mariozechner/pi-coding-agent");
    const services = session.desktopServices;
    if (!services) throw new Error("当前会话未接入 Pi 资源服务。");
    const manager = createManager ? createManager(services) : new DefaultPackageManager({
      ...services, builtinExtensions: ["codemode", "tool-search", "mcp"],
    });
    return { session, manager };
  }

  async function list() {
    const { session, manager } = await context();
    const loader = session.resourceLoader;
    const skills = loader.getSkills().skills;
    return {
      sessionId: session.sessionId,
      cwd: session.sessionManager.getCwd(),
      projectTrusted: session.settingsManager.isProjectTrusted(),
      packages: manager.listConfiguredPackages().map(({ source, scope, filtered, installedPath }) => {
        const entries = scope === "project" ? session.settingsManager.getProjectSettings().packages : session.settingsManager.getGlobalSettings().packages;
        const entry = (entries ?? []).find(item => (typeof item === "string" ? item : item.source) === source);
        const filters = {};
        for (const key of ["extensions", "skills", "prompts", "themes", "autoload"]) if (entry?.[key] !== undefined) filters[key] = entry[key];
        return { source, scope, filtered, installedPath, filters };
      }),
      skills: skills.map(({ name, description }) => ({ name, description })),
      prompts: session.promptTemplates.map(({ name, description }) => ({ name, description })),
      extensions: loader.getExtensions().extensions.map(({ path: extensionPath, resolvedPath, sourceInfo }) => {
        const parts = (resolvedPath || extensionPath).split(/[\\/]/);
        let name = parts.pop().replace(/\.[cm]?[jt]s$/i, "");
        const packageName = sourceInfo?.source.match(/^npm:((?:@[^/]+\/)?[^@]+)/)?.[1];
        if (name === "index") {
          name = parts.pop();
          // 编译输出目录不是扩展名称；这时采用 Pi 已登记的 npm 包名。
          if (packageName && ["src", "dist", "lib", "build"].includes(name)) name = packageName;
        }
        if (packageName && ["pi-extension", "extension"].includes(name)) name = packageName;
        if (extensionPath.startsWith("builtin:")) name = extensionPath.slice("builtin:".length);
        return { path: extensionPath, name };
      }),
      diagnostics: session.desktopResourceDiagnostics ?? [],
    };
  }

  async function manage(input, onProgress = () => {}) {
    const { action, scope } = input ?? {};
    let { source } = input ?? {};
    if (!["install", "update", "remove", "filter", "reload", "check"].includes(action)) throw new Error("包操作无效。");
    if (action === "install" && typeof source === "string") {
      source = source.trim();
      const command = source.match(/^pi\s+install(?:\s+([\s\S]*))?$/);
      if (command) {
        // 仅提取一项来源，不执行粘贴的命令；安装范围仍由页面选择。
        const argument = (command[1] ?? "").match(/^(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s"'`]+))$/);
        if (!argument) throw new Error("请只粘贴一个包来源，例如 npm:billion-context；配置范围请在页面选择。");
        source = argument[1] ?? argument[2] ?? argument[3];
      }
    }
    if (action !== "reload" && action !== "check" && (typeof source !== "string" || !source.trim() || source.startsWith("-") || source.includes("\0"))) {
      throw new Error("请输入 Pi 支持的包来源。");
    }
    if (action !== "reload" && action !== "check" && !["user", "project"].includes(scope)) throw new Error("包配置范围无效。");
    const { session, manager } = await context();
    if (scope === "project" && !session.settingsManager.isProjectTrusted()) throw new Error("请先信任项目资源，再修改项目包。");
    manager.setProgressCallback(onProgress);
    try {
      if (action === "check") return { updates: await manager.checkForAvailableUpdates() };
      if (action === "reload") {
        await session.desktopReloadResources();
        return { reloaded: true };
      }
      const local = scope === "project";
      if (action !== "install" && !manager.listConfiguredPackages().some(item => item.source === source && item.scope === scope)) {
        throw new Error("包配置已变化，请重新读取列表。");
      }
      if (action === "filter") {
        const filters = input.filters;
        if (!filters || typeof filters !== "object" || Array.isArray(filters)) throw new Error("资源筛选必须是对象。");
        for (const [key, value] of Object.entries(filters)) {
          if (key === "autoload" ? typeof value !== "boolean" : !["extensions", "skills", "prompts", "themes"].includes(key) || !Array.isArray(value) || value.some(item => typeof item !== "string")) {
            throw new Error("资源筛选仅支持 Pi 的 extensions/skills/prompts/themes 字符串数组及 autoload 布尔值。");
          }
        }
        const settings = session.settingsManager;
        const entries = (local ? settings.getProjectSettings() : settings.getGlobalSettings()).packages ?? [];
        const next = entries.map(item => (typeof item === "string" ? item : item.source) === source ? { source, ...filters } : item);
        if (local) settings.setProjectPackages(next);
        else settings.setPackages(next);
      }
      if (action === "install") await manager.installAndPersist(source, { local });
      if (action === "remove") await manager.removeAndPersist(source, { local });
      if (action === "update") await manager.update(source);
      // 不发明事务或回滚语义：依官方结果保存，重载失败明确保留已发生的安装事实。
      await session.settingsManager.flush();
      return { changed: true, needsReload: true };
    } finally {
      manager.setProgressCallback(undefined);
    }
  }

  return { list, manage };
}

module.exports = { createPiPackageService };
