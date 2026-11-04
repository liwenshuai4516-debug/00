const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, utimes,
} = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");
const {
  createTestDataService,
} = require("../../src/main/services/test-data-service.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-test-data-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(workspace, "qa", "data");
  await mkdir(path.join(dataRoot, "ui", "cases"), { recursive: true });
  await writeFile(path.join(dataRoot, "ui", "cases", "demo.spec.cjs"), "console.log('demo');\n");
  await writeFile(path.join(dataRoot, "ui", "cases", "demo.md"), "# demo\n");
  await writeFile(path.join(dataRoot, "root.txt"), "root\n");
  await writeFile(path.join(dataRoot, ".hidden"), "hidden\n");

  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(dataRoot, "ui", "cases", "link.txt"));

  const store = createProjectStore(path.join(base, "config", "projects.json"));
  const project = await store.add(workspace);
  const service = createTestDataService(store);
  return { base, workspace, dataRoot, store, project, service, outside };
}

test("列出 qa/data 下的相对路径并跳过隐藏文件和符号链接", async (t) => {
  const { service, project } = await setup(t);
  const result = await service.list(project.id);

  assert.equal(result.available, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.items.map((item) => item.path),
    ["ui/cases/demo.md", "ui/cases/demo.spec.cjs", "root.txt"],
  );
  for (const item of result.items) {
    assert.equal(path.isAbsolute(item.path), false);
    assert.equal(item.path.startsWith(".."), false);
  }
  assert.equal(result.items.some((item) => item.name === ".hidden"), false);
  assert.equal(result.items.some((item) => item.name === "link.txt"), false);
  const spec = result.items.find((item) => item.name === "demo.spec.cjs");
  assert.equal(spec.category, "ui");
  assert.ok(spec.size > 0);
  assert.ok(Number.isFinite(spec.modifiedAt));
});

test("删除单个文件并保留其他测试数据", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const result = await service.remove(project.id, "ui/cases/demo.spec.cjs");
  assert.deepEqual(result, { path: "ui/cases/demo.spec.cjs" });
  await assert.rejects(access(path.join(dataRoot, "ui", "cases", "demo.spec.cjs")));
  assert.match(await readFile(path.join(dataRoot, "ui", "cases", "demo.md"), "utf8"), /demo/);
  assert.match(await readFile(path.join(dataRoot, "root.txt"), "utf8"), /root/);
});

test("拒绝目录穿越、绝对路径、目录、符号链接与缺失文件", async (t) => {
  const { service, project, dataRoot, outside } = await setup(t);
  const invalidPaths = [
    "",
    "../outside.txt",
    "ui/../../outside.txt",
    "..\\outside.txt",
    path.join(dataRoot, "root.txt"),
    "ui",
    "ui/cases",
    "ui/cases/link.txt",
    "ui/cases/missing.txt",
  ];

  for (const relativePath of invalidPaths) {
    await assert.rejects(service.remove(project.id, relativePath));
  }
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.match(await readFile(path.join(dataRoot, "root.txt"), "utf8"), /root/);
});

test("没有 qa/data、未知项目或无效编号明确返回/报错", async (t) => {
  const { service, project, base, store } = await setup(t);
  const emptyWorkspace = path.join(base, "empty");
  await mkdir(emptyWorkspace, { recursive: true });
  const emptyProject = await store.add(emptyWorkspace);
  const empty = await service.list(emptyProject.id);
  assert.deepEqual(empty, { available: false, truncated: false, items: [] });

  await assert.rejects(service.list("missing"), /未找到该项目环境/);
  await assert.rejects(service.remove("missing", "root.txt"), /未找到该项目环境/);
  await assert.rejects(service.remove(project.id, "root.txt/child"));
});

test("列表按分类和修改时间稳定排序", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const first = path.join(dataRoot, "ui", "cases", "demo.md");
  const second = path.join(dataRoot, "root.txt");
  await utimes(first, new Date(1000), new Date(1000));
  await utimes(second, new Date(2000), new Date(2000));

  const result = await service.list(project.id);
  assert.deepEqual(
    result.items.map((item) => item.path),
    ["ui/cases/demo.spec.cjs", "ui/cases/demo.md", "root.txt"],
  );
});
