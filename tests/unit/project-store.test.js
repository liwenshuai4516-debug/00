const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, realpath, symlink, writeFile, readFile, readdir, rm,
} = require("node:fs/promises");
const {
  createProjectStore,
} = require("../../src/main/storage/project-store.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-project-store-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = path.join(base, "team-a", "demo");
  const second = path.join(base, "team-b", "demo");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const storagePath = path.join(base, "config", "projects.json");
  const store = createProjectStore(storagePath);
  return { base, first, second, storagePath, store };
}

test("没有项目记录时返回空列表，不主动创建配置", async (t) => {
  const { storagePath, store } = await setup(t);
  assert.deepEqual(await store.list(), []);
  await assert.rejects(readFile(storagePath), { code: "ENOENT" });
});

test("保存真实目录和稳定编号，重建实例后可恢复，符号链接不重复登记", async (t) => {
  const { base, first, second, storagePath, store } = await setup(t);
  const project = await store.add(first);
  assert.ok(project.id);
  assert.deepEqual(project, {
    id: project.id,
    name: "demo",
    workspaceDir: await realpath(first),
  });

  const alias = path.join(base, "alias");
  await symlink(first, alias);
  const before = await readFile(storagePath, "utf8");
  assert.deepEqual(await store.add(alias), project);
  assert.equal(await readFile(storagePath, "utf8"), before);

  // 同名文件夹位于不同路径时，应建立不同项目。
  const another = await store.add(second);
  assert.notEqual(another.id, project.id);
  assert.equal(another.name, "demo");
  const reopened = createProjectStore(storagePath);
  assert.deepEqual(await reopened.list(), [project, another]);
  assert.deepEqual(await readdir(path.dirname(storagePath)), ["projects.json"]);
});

test("无效目录不会覆盖已有项目列表", async (t) => {
  const { base, first, storagePath, store } = await setup(t);
  await store.add(first);
  const before = await readFile(storagePath, "utf8");
  const file = path.join(base, "file.txt");
  await writeFile(file, "test");

  for (const value of [undefined, "relative/path", file, path.join(base, "missing")]) {
    await assert.rejects(store.add(value));
    assert.equal(await readFile(storagePath, "utf8"), before);
  }
});

test("项目目录失效后仍保留登记，不静默删除或切到其他目录", async (t) => {
  const { first, storagePath, store } = await setup(t);
  const project = await store.add(first);
  const before = await readFile(storagePath, "utf8");
  await rm(first, { recursive: true });

  assert.deepEqual(await store.list(), [project]);
  await assert.rejects(store.add(first));
  assert.equal(await readFile(storagePath, "utf8"), before);
});

test("损坏、字段错误或重复记录明确拒绝，添加操作不覆盖原文件", async (t) => {
  const { first, second, storagePath, store } = await setup(t);
  await mkdir(path.dirname(storagePath), { recursive: true });
  const project = { id: "p1", name: "项目", workspaceDir: await realpath(first) };
  const invalidRecords = [
    "{broken", "null", JSON.stringify({ projects: null }),
    ...[
      null,
      { ...project, id: "" },
      { ...project, name: " " },
      { ...project, workspaceDir: "relative/path" },
    ].map((item) => JSON.stringify({ projects: [item] })),
    JSON.stringify({ projects: [project, { ...project, id: "p2" }] }),
    JSON.stringify({
      projects: [project, { ...project, workspaceDir: await realpath(second) }],
    }),
  ];

  for (const text of invalidRecords) {
    await writeFile(storagePath, text);
    await assert.rejects(store.list());
    await assert.rejects(store.add(first));
    assert.equal(await readFile(storagePath, "utf8"), text);
  }
});