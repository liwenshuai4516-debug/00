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
