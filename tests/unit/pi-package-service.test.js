const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createPiPackageService } = require("../../src/main/services/pi-package-service.js");

test("包服务使用官方安装、范围、筛选、解析、重载与移除契约", async t => {
  const { SettingsManager, DefaultPackageManager } = await import("@mariozechner/pi-coding-agent");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-package-service-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
  let source = path.join(root, "package");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(source, "skills/example"), { recursive: true });
  await fs.mkdir(path.join(source, "prompts"));
  await fs.writeFile(path.join(source, "package.json"), JSON.stringify({ name: "fixture", pi: { skills: ["./skills"], prompts: ["./prompts"] } }));
  await fs.writeFile(path.join(source, "skills/example/SKILL.md"), "---\nname: example\ndescription: 测试技能\n---\n内容");
  await fs.writeFile(path.join(source, "prompts/example.md"), "测试 $1");
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
  let reloads = 0;
  const session = { sessionId: "fixture", settingsManager,
    sessionManager: { getCwd: () => cwd }, desktopServices: { cwd, agentDir, settingsManager },
    resourceLoader: { getSkills: () => ({ skills: [{ name: "example", description: "测试" }] }), getExtensions: () => ({ extensions: [] }) },
    promptTemplates: [{ name: "example", description: "测试模板" }], desktopReloadResources: async () => { reloads++; },
  };
  const service = createPiPackageService({ getSession: async () => session });
  await assert.rejects(service.manage({ action: "install", source, scope: "project" }), /先信任/);
  assert.deepEqual(await service.manage({ action: "install", source, scope: "user" }), { changed: true, needsReload: true });
  assert.equal(reloads, 0, "安装不自动激活扩展");
  const listed = await service.list();
  assert.equal(listed.packages[0].scope, "user");
  assert.equal(listed.packages[0].installedPath, source);
  // 官方将本地路径规范化为配置目录的相对来源，后续操作使用登记值。
  source = listed.packages[0].source;
  await assert.rejects(service.manage({ action: "filter", source, scope: "user", filters: { tools: [] } }), /资源筛选仅支持/);
  await service.manage({ action: "filter", source, scope: "user", filters: { skills: [], prompts: ["**/*.md"], autoload: false } });
  assert.deepEqual((await service.list()).packages[0].filters, { skills: [], prompts: ["**/*.md"], autoload: false });
  const resolved = await new DefaultPackageManager(session.desktopServices).resolve();
  assert.equal(resolved.skills.filter(item => item.metadata.source === source && item.enabled).length, 0);
  assert.equal(resolved.prompts.filter(item => item.metadata.source === source && item.enabled).length, 1);
  assert.deepEqual(await service.manage({ action: "check" }), { updates: [] });
  await service.manage({ action: "reload" });
  assert.equal(reloads, 1);
  await service.manage({ action: "remove", source, scope: "user" });
  assert.deepEqual((await service.list()).packages, []);
  await assert.rejects(service.manage({ action: "update", source, scope: "user" }), /包配置已变化/);
});

test("npm/Git 来源交给官方管理器，失败不谎报成功或虚构回滚", async () => {
  const calls = [];
  const manager = {
    setProgressCallback: callback => calls.push(["progress", Boolean(callback)]),
    installAndPersist: async (source, options) => { calls.push([source, options]); throw new Error("安装失败"); },
  };
  const session = { desktopServices: {}, settingsManager: { isProjectTrusted: () => true } };
  const service = createPiPackageService({ getSession: async () => session }, () => manager);
  for (const source of ["npm:example@^1.0.0", "git:github.com/example/repo@main"]) {
    await assert.rejects(service.manage({ action: "install", source, scope: "project" }), /安装失败/);
    assert.deepEqual(calls.at(-2), [source, { local: true }]);
    assert.deepEqual(calls.at(-1), ["progress", false]);
  }
  await assert.rejects(service.manage({ action: "install", source: "--help", scope: "user" }), /包来源/);
});

test("扩展列表返回可识别名称，不把入口文件作为名称", async () => {
  const extensions = [
    { path: "builtin:codemode" },
    { path: "/packages/pi-subagents/index.js" },
    { path: "/packages/pi-chrome/extensions/chrome-profile-bridge/index.ts" },
    { path: "/packages/example/dist/index.mjs", sourceInfo: { source: "npm:@example/session-tools@1.0.0" } },
    { path: "/project/.pi/extensions/session-tools.ts" },
    { path: "C:\\project\\.pi\\extensions\\my-extension\\index.js" },
    { path: "/packages/postman/dist/pi-extension.js", sourceInfo: { source: "npm:@postman/postman-plugin" } },
  ];
  const session = {
    desktopServices: {}, sessionId: "names", sessionManager: { getCwd: () => "/temporary" },
    settingsManager: { isProjectTrusted: () => true }, promptTemplates: [],
    resourceLoader: { getSkills: () => ({ skills: [] }), getExtensions: () => ({ extensions }) },
  };
  const service = createPiPackageService({ getSession: async () => session }, () => ({ listConfiguredPackages: () => [] }));
  const listed = (await service.list()).extensions;
  assert.deepEqual(listed.map(item => item.name), ["codemode", "pi-subagents", "chrome-profile-bridge", "@example/session-tools", "session-tools", "my-extension", "@postman/postman-plugin"]);
  assert.deepEqual(listed.map(item => item.path), extensions.map(item => item.path));
});

test("安装接受复制的 pi install 命令，只把包来源交给官方安装器", async () => {
  const calls = [];
  const manager = {
    setProgressCallback() {},
    installAndPersist: async (source, options) => calls.push({ source, options }),
  };
  const session = { desktopServices: {}, settingsManager: { isProjectTrusted: () => true, flush: async () => {} } };
  const service = createPiPackageService({ getSession: async () => session }, () => manager);
  for (const [input, source] of [
    ["pi install npm:billion-context", "npm:billion-context"],
    ["  pi install npm:@example/tools@1.0.0  ", "npm:@example/tools@1.0.0"],
    ['pi install "/temporary/work space/package"', "/temporary/work space/package"],
    ["pi install 'git:github.com/example/repo@main'", "git:github.com/example/repo@main"],
    ["/temporary/work space/package", "/temporary/work space/package"],
    ["npm:billion-context", "npm:billion-context"],
  ]) {
    await service.manage({ action: "install", source: input, scope: "user" });
    assert.deepEqual(calls.at(-1), { source, options: { local: false } });
  }
  const count = calls.length;
  for (const source of ["pi install", "pi install npm:a npm:b", "pi install --local npm:a", "pi install npm:a && echo x", 'pi install "unterminated', 'pi install ""', "pi install --help"]) {
    await assert.rejects(service.manage({ action: "install", source, scope: "user" }), /包来源|只粘贴/);
  }
  assert.equal(calls.length, count, "无效命令不进入安装器");
});

test("资源只依据 Pi 来源关联所属包，卸载后保留待重载身份", async () => {
  let configured = true;
  const sourceInfo = { source: "npm:fixture", scope: "project", origin: "package" };
  const session = {
    desktopServices: {}, sessionId: "owners", sessionManager: { getCwd: () => "/temporary" },
    settingsManager: { isProjectTrusted: () => true, getProjectSettings: () => ({ packages: ["npm:fixture"] }) },
    resourceLoader: {
      getSkills: () => ({ skills: [{ name: "packaged", sourceInfo }, { name: "independent", sourceInfo: { ...sourceInfo, origin: "top-level" } }] }),
      getExtensions: () => ({ extensions: [{ path: "/package/index.js", sourceInfo }, { path: "builtin:mcp" }] }),
    },
    promptTemplates: [{ name: "template", sourceInfo }],
  };
  const service = createPiPackageService({ getSession: async () => session }, () => ({
    listConfiguredPackages: () => configured ? [{ source: "npm:fixture", scope: "project" }] : [],
  }));
  let listed = await service.list();
  for (const item of [listed.skills[0], listed.prompts[0], listed.extensions[0]]) {
    assert.deepEqual(item.package, { source: "npm:fixture", scope: "project", configured: true });
  }
  assert.equal(listed.skills[1].package, undefined);
  assert.equal(listed.extensions[1].package, undefined);
  configured = false;
  listed = await service.list();
  assert.deepEqual(listed.skills[0].package, { source: "npm:fixture", scope: "project", configured: false });
});

test("卸载使用官方范围与返回值，不把失败或配置未变谎报为成功", async () => {
  const calls = [];
  let trusted = false, mode = "success";
  const session = { desktopServices: {}, settingsManager: {
    isProjectTrusted: () => trusted, flush: async () => calls.push("flush"),
  } };
  const service = createPiPackageService({ getSession: async () => session }, () => ({
    setProgressCallback: value => calls.push(Boolean(value)),
    listConfiguredPackages: () => [{ source: "npm:fixture", scope: "user" }, { source: "npm:fixture", scope: "project" }],
    removeAndPersist: async (source, options) => {
      calls.push({ source, options });
      if (mode === "failure") throw Error("官方卸载失败");
      return mode === "success";
    },
  }));
  await assert.rejects(service.manage({ action: "remove", source: "npm:fixture", scope: "project" }), /先信任/);
  assert.deepEqual(calls, []);
  await assert.rejects(service.manage({ action: "remove", source: "npm:not-configured", scope: "user" }), /包配置已变化/);
  trusted = true;
  assert.deepEqual(await service.manage({ action: "remove", source: "npm:fixture", scope: "project" }), { changed: true, needsReload: true });
  assert.ok(calls.some(call => call?.source === "npm:fixture" && call.options.local === true));
  mode = "failure";
  await assert.rejects(service.manage({ action: "remove", source: "npm:fixture", scope: "user" }), /官方卸载失败/);
  assert.equal(calls.at(-1), false, "失败后解除进度订阅");
  mode = "unchanged";
  await assert.rejects(service.manage({ action: "remove", source: "npm:fixture", scope: "user" }), /未确认.*刷新/);
});

test("官方 npm 与 Git 卸载仅处理所选范围的安装和配置", async t => {
  const { SettingsManager, DefaultPackageManager } = await import("@mariozechner/pi-coding-agent");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-uninstall-scopes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
  await fs.mkdir(cwd, { recursive: true });
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  // 使用离线 npm 和临时已安装夹具，验证官方卸载，不访问注册表或个人安装。
  settingsManager.setNpmCommand(["npm", "--offline", "--no-audit", "--no-fund"]);
  const packageName = "pi-uninstall-fixture";
  const sources = [`npm:${packageName}@1.0.0`, "git:github.com/example/pi-uninstall-fixture@v1"];
  settingsManager.setPackages(sources);
  settingsManager.setProjectPackages(sources);
  const roots = [agentDir, path.join(cwd, ".pi")];
  for (const directory of roots) {
    const npmRoot = path.join(directory, "npm");
    const installed = path.join(npmRoot, "node_modules", packageName);
    await fs.mkdir(installed, { recursive: true });
    await fs.writeFile(path.join(installed, "package.json"), JSON.stringify({ name: packageName, version: "1.0.0" }));
    await fs.writeFile(path.join(npmRoot, "package.json"), JSON.stringify({ name: "temporary-installs", private: true, dependencies: { [packageName]: "1.0.0" } }));
    const checkout = path.join(directory, "git/github.com/example/pi-uninstall-fixture");
    await fs.mkdir(checkout, { recursive: true });
    await fs.writeFile(path.join(checkout, "marker"), "temporary checkout");
  }
  const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager });
  const session = { desktopServices: { cwd, agentDir, settingsManager }, settingsManager };
  const service = createPiPackageService({ getSession: async () => session });
  const installed = manager.listConfiguredPackages();
  for (const source of sources) {
    const projectPath = installed.find(item => item.source === source && item.scope === "project").installedPath;
    const userPath = installed.find(item => item.source === source && item.scope === "user").installedPath;
    assert.ok(projectPath && userPath);
    await service.manage({ action: "remove", source, scope: "project" });
    await assert.rejects(fs.access(projectPath), { code: "ENOENT" });
    await fs.access(userPath);
    assert.ok(settingsManager.getGlobalSettings().packages.includes(source));
    assert.ok(!settingsManager.getProjectSettings().packages.includes(source));
  }
  const reopened = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  assert.deepEqual(reopened.getProjectSettings().packages, []);
  assert.deepEqual(reopened.getGlobalSettings().packages, sources);
  for (const source of sources) {
    const userPath = installed.find(item => item.source === source && item.scope === "user").installedPath;
    await service.manage({ action: "remove", source, scope: "user" });
    await assert.rejects(fs.access(userPath), { code: "ENOENT" });
  }
  assert.deepEqual(settingsManager.getGlobalSettings().packages, []);
});

test("单项停用使用官方精确排除，不影响同包技能、模板和独立技能文件", async t => {
  const { SettingsManager, DefaultResourceLoader } = await import("@mariozechner/pi-coding-agent");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-disable-skill-"));
  // 隔离个人技能目录，避免本机 ~/.agents/skills 混入固定期望。
  const previousHome = process.env.HOME;
  process.env.HOME = root;
  t.after(async () => {
    if (previousHome === undefined) delete process.env.HOME;
    else process.env.HOME = previousHome;
    await fs.rm(root, { recursive: true, force: true });
  });
  const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent"), packageDir = path.join(root, "package");
  await fs.mkdir(cwd);
  for (const [directory, name] of [[path.join(packageDir, "skills/first"), "first"], [path.join(packageDir, "skills/second"), "second"], [path.join(agentDir, "skills/standalone"), "standalone"], [path.join(cwd, ".pi/skills/project-only"), "project-only"], [path.join(cwd, ".agents/skills/agents-only"), "agents-only"]]) {
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "SKILL.md"), `---\nname: ${name}\ndescription: 测试技能\n---\n正文`);
  }
  await fs.mkdir(path.join(packageDir, "prompts"));
  await fs.writeFile(path.join(packageDir, "prompts/review.md"), "审查 $1");
  const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  settingsManager.setPackages([{ source: packageDir, prompts: ["prompts/*.md"], autoload: true, skills: ["skills/**", "+skills/first/SKILL.md"] }]);
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
  await loader.reload();
  const session = { desktopServices: { cwd, agentDir, settingsManager }, settingsManager, resourceLoader: loader, sessionId: "skills", sessionManager: { getCwd: () => cwd }, promptTemplates: loader.getPrompts().prompts };
  const service = createPiPackageService({ getSession: async () => session });
  const projectSkill = (await service.list()).skills.find(item => item.name === "project-only");
  settingsManager.setProjectTrusted(false);
  await assert.rejects(service.manage({ action: "disable-skill", source: projectSkill.control.source, scope: "project" }), /先信任/);
  settingsManager.setProjectTrusted(true);
  await assert.rejects(service.manage({ action: "disable-skill", source: projectSkill.control.source, scope: "user" }), /技能来源已变化/);
  async function disable(name) {
    const skill = (await service.list()).skills.find(item => item.name === name);
    assert.ok(skill.control, "技能具有单项停用入口");
    await service.manage({ action: "disable-skill", source: skill.control.source, scope: skill.control.scope });
    assert.equal((await service.list()).skills.find(item => item.name === name).control.disabled, true, "重载前标记为待应用");
    await fs.access(skill.control.source);
    await loader.reload();
    assert.ok(!loader.getSkills().skills.some(item => item.name === name));
  }
  await disable("first");
  assert.ok(loader.getSkills().skills.some(item => item.name === "second"));
  assert.equal(loader.getPrompts().prompts.length, 1);
  assert.deepEqual(settingsManager.getGlobalSettings().packages, [{ source: packageDir, prompts: ["prompts/*.md"], autoload: true, skills: ["skills/**", "-skills/first/SKILL.md"] }]);
  await disable("standalone");
  await disable("project-only");
  await disable("agents-only");
  assert.ok(loader.getSkills().skills.some(item => item.name === "second"));
  await assert.rejects(service.manage({ action: "disable-skill", source: path.join(root, "not-loaded.md"), scope: "user" }), /技能.*变化|技能.*不存在/);
  const reopened = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const next = new DefaultResourceLoader({ cwd, agentDir, settingsManager: reopened });
  await next.reload();
  assert.deepEqual(next.getSkills().skills.map(item => item.name), ["second"]);
});
