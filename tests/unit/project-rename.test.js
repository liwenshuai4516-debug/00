const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, readFile, writeFile, readdir, rm,
} = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-project-rename-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  await mkdir(first);
  await mkdir(second);
  const storagePath = path.join(base, "config", "projects.json");
  const store = createProjectStore(storagePath);
  const project = await store.add(first);
  const another = await store.add(second);
  return { first, storagePath, store, project, another };
}

test("重命名持久化，保留编号、目录、顺序及其他项目", async (t) => {
  const { first, storagePath, store, project, another } = await setup(t);
  const marker = path.join(first, "marker.txt");
  await writeFile(marker, "工作文件保持原样");
  const expected = { ...project, name: "客户项目" };
  assert.deepEqual(await store.rename(project.id, "  客户项目  "), expected);
  const reopened = createProjectStore(storagePath);
  assert.deepEqual(await reopened.list(), [expected, another]);
  assert.equal(await readFile(marker, "utf8"), "工作文件保持原样");

  // 重复添加同目录仍返回已有编号和用户设置的名称。
  assert.deepEqual(await reopened.add(first), expected);
  const before = await readFile(storagePath, "utf8");
  assert.deepEqual(await reopened.rename(project.id, "客户项目"), expected);
  assert.equal(await readFile(storagePath, "utf8"), before);
  assert.deepEqual(await readdir(path.dirname(storagePath)), ["projects.json"]);
});

test("无效编号、未知项目和无效名称不覆盖记录", async (t) => {
  const { storagePath, store, project } = await setup(t);
  const before = await readFile(storagePath, "utf8");
  for (const id of [undefined, null, "", "  ", 1, {}]) {
    await assert.rejects(store.rename(id, "项目"), /请选择项目/);
  }
  await assert.rejects(store.rename("missing", "项目"), /未找到该项目/);
  for (const name of [undefined, null, "", "  ", 1, {}, "名".repeat(41)]) {
    await assert.rejects(store.rename(project.id, name), /1～40/);
    assert.equal(await readFile(storagePath, "utf8"), before);
  }
  assert.equal(await readFile(storagePath, "utf8"), before);
  const boundary = "名".repeat(40);
  assert.equal((await store.rename(project.id, boundary)).name, boundary);
});

test("目录暂时失效仍能修改登记名称，不重建工作目录", async (t) => {
  const { first, store, project, another } = await setup(t);
  await rm(first, { recursive: true });
  const expected = { ...project, name: "离线项目" };
  assert.deepEqual(await store.rename(project.id, expected.name), expected);
  assert.deepEqual(await store.list(), [expected, another]);
  await assert.rejects(readdir(first), { code: "ENOENT" });
});

test("配置损坏时拒绝重命名，保留原始内容", async (t) => {
  const { storagePath, store, project } = await setup(t);
  await writeFile(storagePath, "{broken");
  await assert.rejects(store.rename(project.id, "新名称"));
  assert.equal(await readFile(storagePath, "utf8"), "{broken");
});