const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const context = import("../../src/main/capabilities/ui-testing/project-context.mjs");

async function setup(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-project-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "当前工作区");
  const other = path.join(base, "登记项目目录");
  await fs.mkdir(workspace);
  await fs.mkdir(other);
  const runtime = { projectConfig: path.join(base, "projects.json") };
  const projects = [{ id: "pms", name: "项目管理系统", workspaceDir: other,
    address: "http://127.0.0.1:8238/", account: "private-account", password: "private-password" }];
  const save = () => fs.writeFile(runtime.projectConfig, JSON.stringify({ projects }));
  await save();
  return { base, workspace, other, runtime, projects, save };
}

test("项目按 origin/路径范围识别，数据只写当前工作区，返回值不含凭据", async (t) => {
  const { workspace, other, runtime } = await setup(t);
  const { resolveProject, readCredentials } = await context;
  const project = await resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/pms/OperationContract" }, workspace);
  assert.equal(project.projectId, "pms");
  assert.equal(project.credentialsConfigured, true);
  assert.equal(project.workspaceRoot, workspace);
  assert.equal(project.workspaceStatus, "ready");
  assert.equal(project.directoryAction, "created");
  assert.ok(project.createdDirectories.includes(path.join(workspace, "qa")));
  assert.deepEqual(project.cleanupPending, []);
  assert.equal(project.caseDir, path.join(workspace, "qa/data/ui/cases"));
  assert.deepEqual(await fs.readdir(other), []);
  assert.ok(!JSON.stringify(project).includes("private-"));
  const reused = await resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/pms/OperationContract" }, workspace);
  assert.equal(reused.directoryAction, "reused");
  assert.deepEqual(reused.createdDirectories, []);
  assert.equal(reused.dataDir, path.join(workspace, "qa/data"));
  assert.match(project.assetName, /^项目管理系统__pms_OperationContract__/);
  await assert.rejects(resolveProject(runtime, { targetUrl: project.targetUrl, projectName: "错误的项目" }, workspace), /名称.*不一致/);
  assert.equal((await readCredentials(runtime, project)).password, "private-password");
  for (const targetUrl of ["http://127.0.0.1:8239/pms/OperationContract", "https://127.0.0.1:8238/pms/OperationContract", "http://other.invalid:8238/pms"]) {
    await assert.rejects(resolveProject(runtime, { targetUrl }, workspace), /没有.*匹配/);
  }
});

test("最长路径范围优先，等价匹配须明确项目，不按地址字符串前缀选账号", async (t) => {
  const { base, workspace, runtime, projects, save } = await setup(t);
  const { resolveProject, matchesAddress } = await context;
  const second = path.join(base, "第二项目");
  await fs.mkdir(second);
  projects.push({ id: "specific", name: "PMS", workspaceDir: second, address: "http://127.0.0.1:8238/pms" });
  await save();
  assert.equal((await resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/pms/contract" }, workspace)).projectId, "specific");
  assert.equal(matchesAddress("http://127.0.0.1:8238/pms", "http://127.0.0.1:8238/pms-other"), false);
  projects[1].address = "http://127.0.0.1:8238/";
  await save();
  await assert.rejects(resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/pms" }, workspace), /多个项目/);
  assert.equal((await resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/pms", projectId: "pms" }, workspace)).projectId, "pms");
  await assert.rejects(resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/pms", projectId: "missing" }, workspace), /没有.*匹配/);
});

test("工作区未绑定、不匹配、路径冲突和越界链接不创建外部数据", async (t) => {
  const { workspace, other } = await setup(t);
  const { prepareDataDirectory } = await context;
  await assert.rejects(prepareDataDirectory(undefined), /先选择工作区/);
  await assert.rejects(prepareDataDirectory(workspace, other), /不一致/);
  await fs.symlink(other, path.join(workspace, "qa"));
  await assert.rejects(prepareDataDirectory(workspace), /工作区外部/);
  assert.deepEqual(await fs.readdir(other), []);
  await fs.unlink(path.join(workspace, "qa"));
  await fs.writeFile(path.join(workspace, "qa"), "keep");
  await assert.rejects(prepareDataDirectory(workspace), /同名文件/);
  assert.equal(await fs.readFile(path.join(workspace, "qa"), "utf8"), "keep");
});

test("配置变更阻断旧交接，损坏配置不泄露原文，文件命名稳定且避免过长", async (t) => {
  const { workspace, runtime, projects, save } = await setup(t);
  const { resolveProject, readCredentials } = await context;
  const params = { targetUrl: "http://127.0.0.1:8238/很长的中文路径" };
  const first = await resolveProject(runtime, params, workspace);
  assert.equal((await resolveProject(runtime, params, workspace)).assetName, first.assetName);
  projects[0].name = "系统".repeat(30);
  await save();
  await assert.rejects(readCredentials(runtime, first), /配置已变更/);
  const long = await resolveProject(runtime, { targetUrl: "http://127.0.0.1:8238/" + "路径".repeat(100) }, workspace);
  assert.ok(Buffer.byteLength(long.assetName + "__1234567890123-abcdef.seed.spec.cjs") < 255);
  await fs.writeFile(runtime.projectConfig, '{"projects":private-password}');
  await assert.rejects(resolveProject(runtime, params, workspace), (error) => {
    assert.ok(!String(error.stack).includes("private-password"));
    return /格式/.test(error.message);
  });
});
