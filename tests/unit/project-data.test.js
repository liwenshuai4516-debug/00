const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, readFile, writeFile, stat, rm,
} = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");
const { createProjectService } = require("../../src/main/services/project-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-project-data-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "项目 空间");
  await mkdir(workspace);
  const filename = path.join(base, "config", "projects.json");
  const store = createProjectStore(filename);
  const project = await store.add(workspace);
  const service = createProjectService(store);
  async function configure(fields) {
    const data = JSON.parse(await readFile(filename, "utf8"));
    Object.assign(data.projects[0], fields);
    await writeFile(filename, JSON.stringify(data));
  }
  return { base, workspace, filename, store, project, service, configure };
}

test("新增项目预留三个空配置字段，后端读取四项数据且文件权限为 0600", async (t) => {
  const { filename, store, project, service } = await setup(t);
  const expected = { name: project.name, address: "", account: "", password: "" };
  assert.deepEqual(await service.getProjectData(project.id), expected);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), {
    projects: [{ ...project, address: "", account: "", password: "" }],
  });
  if (process.platform !== "win32") {
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await store.list(), [project]);
});

test("旧项目缺少配置字段仍可读取，不自动重写文件", async (t) => {
  const { filename, project, service } = await setup(t);
  const original = JSON.stringify({ projects: [project] });
  await writeFile(filename, original);
  assert.deepEqual(await service.getProjectData(project.id), {
    name: project.name, address: "", account: "", password: "",
  });
  assert.equal(await readFile(filename, "utf8"), original);
});

test("手工配置按编号隔离，每次重读，保留账号密码原文且不访问站点或工作目录", async (t) => {
  const { base, workspace, filename, store, project, configure } = await setup(t);
  const secondWorkspace = path.join(base, "another");
  await mkdir(secondWorkspace);
  const second = await store.add(secondWorkspace);
  const fields = {
    name: "测试系统", address: "https://example.invalid/app", account: " user ", password: " 密码 ' $() ",
  };
  await configure(fields);
  const service = createProjectService(createProjectStore(filename), () => assert.fail("不选择目录"), {
    openWorkspace: () => assert.fail("不打开会话"),
  });
  await rm(workspace, { recursive: true });
  assert.deepEqual(await service.getProjectData(project.id), fields);
  assert.deepEqual(await service.getProjectData(second.id), {
    name: second.name, address: "", account: "", password: "",
  });
  await configure({ password: "replacement" });
  assert.equal((await service.getProjectData(project.id)).password, "replacement");
});

test("项目列表、重复添加和重命名返回白名单字段，保存保留配置和未知字段", async (t) => {
  const { base, filename, workspace, store, project, configure } = await setup(t);
  const fields = { address: "http://localhost:3000", account: "tester", password: "private-value", future: { value: 1 } };
  await configure(fields);
  assert.deepEqual(await store.list(), [project]);
  assert.deepEqual(await store.add(workspace), project);
  const renamed = { ...project, name: "新名称" };
  assert.deepEqual(await store.rename(project.id, renamed.name), renamed);
  const secondWorkspace = path.join(base, "second");
  await mkdir(secondWorkspace);
  await store.add(secondWorkspace);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")).projects[0], { ...renamed, ...fields });
  assert.equal((await store.readData(project.id)).password, fields.password);
});

test("无效字段或地址不回退到空配置，读取失败不修改原文件或泄露字段值", async (t) => {
  const { filename, project, service, configure } = await setup(t);
  for (const fields of [
    { address: null }, { address: 123 }, { account: null }, { password: false },
    { address: "file:///private-value" }, { address: "not-a-url-private-value" },
    { address: "https://user:private-value@example.invalid" },
  ]) {
    await configure({ address: "", account: "", password: "", ...fields });
    const original = await readFile(filename, "utf8");
    await assert.rejects(service.getProjectData(project.id), (error) => {
      assert.ok(!String(error.stack).includes("private-value"));
      return /项目.*配置/.test(error.message);
    });
    assert.equal(await readFile(filename, "utf8"), original);
  }
});

test("配置 JSON 损坏时所有读取及写入均拒绝，错误不携带密码片段", async (t) => {
  const { filename, workspace, project, store, service } = await setup(t);
  const original = '{"projects":private-value}';
  await writeFile(filename, original);
  for (const operation of [
    () => store.list(), () => store.add(workspace),
    () => store.rename(project.id, "新名称"), () => service.getProjectData(project.id),
  ]) {
    await assert.rejects(operation(), (error) => {
      assert.ok(!String(error.stack).includes("private-value"));
      assert.equal(error.cause, undefined);
      return /项目.*格式/.test(error.message);
    });
  }
  assert.equal(await readFile(filename, "utf8"), original);
});

test("后端数据接口只按已登记编号读取，不接受路径或无效编号", async (t) => {
  const { project, service } = await setup(t);
  for (const id of [undefined, null, "", " ", 123, {}, [project.id]]) {
    await assert.rejects(service.getProjectData(id), /请选择项目/);
  }
  for (const id of ["missing", project.workspaceDir]) {
    await assert.rejects(service.getProjectData(id), /未找到该项目/);
  }
});

test("实际项目 IPC 的列表、添加与重命名不传递账号密码", async (t) => {
  const { workspace, store, project, configure } = await setup(t);
  await configure({ address: "https://example.invalid", account: "tester", password: "private-value" });
  const service = createProjectService(store, async () => ({ canceled: false, filePaths: [workspace] }));
  const handlers = new Map();
  registerAgentIpc({ handle: (name, handler) => handlers.set(name, handler) }, {}, { isBusy: () => false }, {}, {}, {}, {}, service);
  assert.deepEqual(await handlers.get("agent:list-projects")({}), [project]);
  assert.deepEqual(await handlers.get("agent:add-project")({ sender: {} }), { canceled: false, project });
  assert.deepEqual(await handlers.get("agent:rename-project")({}, project.id, "名称"), { ...project, name: "名称" });
});
