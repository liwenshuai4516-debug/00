const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const {
  mkdtemp, mkdir, readFile, writeFile, stat, readdir, rm,
} = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-project-config-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const filename = path.join(base, "source", "config", "projects.local.json");
  const legacy = path.join(base, "user-data", "projects.json");
  const project = {
    id: "original-id", name: "原项目", workspaceDir: path.join(base, "workspace"),
    address: "https://example.invalid", account: "tester", password: " private-value ",
  };
  await mkdir(path.dirname(legacy), { recursive: true });
  const original = JSON.stringify({ projects: [project] });
  await writeFile(legacy, original);
  return { base, filename, legacy, project, original };
}

test("项目内配置缺失时完整迁移旧登记与凭据，保留旧文件且页面不返回凭据", async (t) => {
  const { filename, legacy, project, original } = await setup(t);
  const store = createProjectStore(filename, legacy);
  assert.deepEqual(await store.list(), [{ id: project.id, name: project.name, workspaceDir: project.workspaceDir }]);
  assert.deepEqual(JSON.parse(await readFile(filename, "utf8")), { projects: [project] });
  assert.deepEqual(await store.readData(project.id), {
    name: project.name, address: project.address, account: project.account, password: project.password,
  });
  assert.equal(await readFile(legacy, "utf8"), original);
  if (process.platform !== "win32") {
    assert.equal((await stat(filename)).mode & 0o777, 0o600);
  }
  assert.deepEqual(await readdir(path.dirname(filename)), ["projects.local.json"]);
});

test("已有项目内配置优先，包括空列表；损坏新配置不回退或被旧配置覆盖", async (t) => {
  const { filename, legacy } = await setup(t);
  await mkdir(path.dirname(filename), { recursive: true });
  const store = createProjectStore(filename, legacy);
  await writeFile(filename, '{"projects":[]}');
  assert.deepEqual(await store.list(), []);
  const malformed = '{"projects":private-value}';
  await writeFile(filename, malformed);
  await assert.rejects(store.list(), /项目.*格式/);
  assert.equal(await readFile(filename, "utf8"), malformed);
});

test("并发首次读取不会覆盖配置，迁移后的编辑不再从旧位置回填", async (t) => {
  const { filename, legacy } = await setup(t);
  const first = createProjectStore(filename, legacy);
  const second = createProjectStore(filename, legacy);
  const results = await Promise.all([first.list(), second.list()]);
  assert.equal(results[0].length, 1);
  assert.deepEqual(results[0], results[1]);
  await writeFile(filename, '{"projects":[]}');
  assert.deepEqual(await first.list(), []);
  assert.deepEqual(await second.list(), []);
  assert.deepEqual(await readdir(path.dirname(filename)), ["projects.local.json"]);
});

test("损坏旧配置不创建新文件，错误不携带凭据；旧位置缺失时沿用空列表", async (t) => {
  const { filename, legacy } = await setup(t);
  const malformed = '{"projects":private-value}';
  await writeFile(legacy, malformed);
  const store = createProjectStore(filename, legacy);
  await assert.rejects(store.list(), (error) => {
    assert.ok(!String(error.stack).includes("private-value"));
    return /项目.*格式/.test(error.message);
  });
  await assert.rejects(readFile(filename), { code: "ENOENT" });
  assert.equal(await readFile(legacy, "utf8"), malformed);
  await rm(legacy);
  assert.deepEqual(await store.list(), []);
});

test("添加与重命名只写项目内文件，不修改旧配置", async (t) => {
  const { base, filename, legacy, project, original } = await setup(t);
  const store = createProjectStore(filename, legacy);
  await store.rename(project.id, "项目内名称");
  const workspace = path.join(base, "second");
  await mkdir(workspace);
  await store.add(workspace);
  const data = JSON.parse(await readFile(filename, "utf8"));
  assert.equal(data.projects.length, 2);
  assert.deepEqual(data.projects[0], { ...project, name: "项目内名称" });
  assert.equal(await readFile(legacy, "utf8"), original);
});

test("启动入口绑定源码项目配置文件，旧 userData 仅用作兼容迁移来源", () => {
  let received;
  const sourceRoot = path.join(os.tmpdir(), "mock-client-source");
  const userData = path.join(os.tmpdir(), "mock-client-user-data");
  const factories = {
    createExtensionUiBridge: () => ({ register() {}, cancelAll() {}, disconnect() {} }),
    createProjectStore(...args) { received = args; return {}; },
  };
  runInNewContext(readFileSync(path.join(__dirname, "../../src/main/bootstrap.js"), "utf8"), {
    __dirname: path.join(sourceRoot, "src/main"), module: { exports: {} },
    process: { env: {}, platform: "darwin" },
    require(name) {
      if (name === "node:path") return path;
      if (name === "node:process") return { loadEnvFile() {} };
      if (name === "electron") return { app: {
        getPath: () => userData, whenReady: () => ({ then() {} }), on() {},
      }, ipcMain: {} };
      return new Proxy({}, { get: (_target, key) => factories[key] ?? (() => ({})) });
    },
  });
  assert.deepEqual(received, [path.join(sourceRoot, "config", "projects.local.json"), path.join(userData, "projects.json")]);
});
