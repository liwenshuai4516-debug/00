const path = require("node:path");

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

  function skillControl(session, skill) {
    const info = skill.sourceInfo;
    if (!skill.filePath || !["user", "project"].includes(info?.scope)) return undefined;
    const settings = info.scope === "project" ? session.settingsManager.getProjectSettings() : session.settingsManager.getGlobalSettings();
    const entry = info.origin === "package" ? (settings.packages ?? []).find(item => (typeof item === "string" ? item : item.source) === info.source) : undefined;
    if (info.origin === "package" && (!entry || !info.baseDir)) return undefined;
    const pattern = info.origin === "package" ? path.relative(info.baseDir, skill.filePath).split(path.sep).join("/") : skill.filePath.split(path.sep).join("/");
    const patterns = info.origin === "package" ? entry.skills ?? [] : settings.skills ?? [];
    return { source: skill.filePath, scope: info.scope, disabled: patterns.includes(`-${pattern}`), pattern };
  }

  async function list() {
    const { session, manager } = await context();
    const loader = session.resourceLoader;
    const skills = loader.getSkills().skills;
    const packages = manager.listConfiguredPackages();
    function owningPackage(sourceInfo) {
      if (sourceInfo?.origin !== "package") return undefined;
      const { source, scope } = sourceInfo;
      return { source, scope, configured: packages.some(item => item.source === source && item.scope === scope) };
    }
    return {
      sessionId: session.sessionId,
      cwd: session.sessionManager.getCwd(),
      projectTrusted: session.settingsManager.isProjectTrusted(),
      packages: packages.map(({ source, scope, filtered, installedPath }) => {
        const entries = scope === "project" ? session.settingsManager.getProjectSettings().packages : session.settingsManager.getGlobalSettings().packages;
        const entry = (entries ?? []).find(item => (typeof item === "string" ? item : item.source) === source);
        const filters = {};
        for (const key of ["extensions", "skills", "prompts", "themes", "autoload"]) if (entry?.[key] !== undefined) filters[key] = entry[key];
        return { source, scope, filtered, installedPath, filters };
      }),
      skills: skills.map(skill => {
        const { name, description, sourceInfo } = skill;
        const control = skillControl(session, skill);
        return { name, description, package: owningPackage(sourceInfo), control: control && { source: control.source, scope: control.scope, disabled: control.disabled } };
      }),
      prompts: session.promptTemplates.map(({ name, description, sourceInfo }) => ({ name, description, package: owningPackage(sourceInfo) })),
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
        return { path: extensionPath, name, package: owningPackage(sourceInfo) };
      }),
      diagnostics: session.desktopResourceDiagnostics ?? [],
    };
  }

  async function manage(input, onProgress = () => {}) {
    const { action, scope } = input ?? {};
    let { source } = input ?? {};
    if (!["install", "update", "remove", "filter", "reload", "check", "disable-skill"].includes(action)) throw new Error("包操作无效。");
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
      if (action === "disable-skill") {
        const skill = session.resourceLoader.getSkills().skills.find(item => item.filePath === source);
        const control = skill && skillControl(session, skill);
        if (!control || control.scope !== scope) throw new Error("技能来源已变化或技能不存在，请刷新列表后重试。");
        const settings = session.settingsManager;
        const scoped = scope === "project" ? settings.getProjectSettings() : settings.getGlobalSettings();
        const exclude = patterns => [...patterns.filter(item => item !== `+${control.pattern}` && item !== `-${control.pattern}`), `-${control.pattern}`];
        if (skill.sourceInfo.origin === "package") {
          const packages = scoped.packages.map(item => {
            if ((typeof item === "string" ? item : item.source) !== skill.sourceInfo.source) return item;
            const entry = typeof item === "string" ? { source: item } : item;
            return { ...entry, skills: exclude(entry.skills ?? []) };
          });
          if (scope === "project") settings.setProjectPackages(packages);
          else settings.setPackages(packages);
        } else {
          const patterns = exclude(scoped.skills ?? []);
          if (scope === "project") settings.setProjectSkillPaths(patterns);
          else settings.setSkillPaths(patterns);
        }
        await settings.flush();
        return { changed: true, needsReload: true };
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
      if (action === "remove") {
        const changed = await manager.removeAndPersist(source, { local });
        if (!changed) throw new Error("未确认包配置已移除，请刷新列表核对；磁盘可能已发生变化。");
      }
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
