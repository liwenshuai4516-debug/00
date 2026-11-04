const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, readFile, rm, stat } = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-project-env-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const first = path.join(base, "first");
  const second = path.join(base, "second");
  await mkdir(first, { recursive: true });
  await mkdir(second, { recursive: true });
  const storagePath = path.join(base, "config", "projects.json");
  const store = createProjectStore(storagePath);
  const a = await store.add(first);
  const b = await store.add(second);
  return { base, first, second, storagePath, store, a, b };
}

test("环境列表只回传声明字段，密码只报告是否配置", async (t) => {
  const { store, a, b } = await setup(t);
  await store.updateData(a.id, {
    name: "订单系统",
    address: "https://example.invalid",
    account: "demo",
    password: "secret-value",
  });

  const environments = await store.listEnvironments();
  assert.equal(environments.length, 2);
  const first = environments.find((item) => item.id === a.id);
  assert.deepEqual(first, {
    id: a.id,
    name: "订单系统",
    workspaceDir: a.workspaceDir,
    address: "https://example.invalid",
    account: "demo",
    passwordConfigured: true,
  });
  assert.equal("password" in first, false);
  assert.equal(JSON.stringify(environments).includes("secret-value"), false);

  const second = environments.find((item) => item.id === b.id);
  assert.equal(second.passwordConfigured, false);
  assert.equal(second.address, "");
});

test("更新名称、地址和账号时保持密码，缺省不改密码", async (t) => {
  const { store, a } = await setup(t);
  await store.updateData(a.id, {
    address: "https://old.invalid",
    account: "old",
    password: "keep-me",
  });

  const updated = await store.updateData(a.id, {
    name: "新名称",
    address: "https://new.invalid",
    account: "new",
  });
  assert.equal(updated.name, "新名称");
  assert.equal(updated.address, "https://new.invalid");
  assert.equal(updated.account, "new");
  assert.equal(updated.passwordConfigured, true);

  const data = await store.readData(a.id);
  assert.equal(data.name, "新名称");
  assert.equal(data.address, "https://new.invalid");
  assert.equal(data.account, "new");
  assert.equal(data.password, "keep-me");
});

test("显式空密码清除、非空密码替换，账号原文保留", async (t) => {
  const { store, a } = await setup(t);
  await store.updateData(a.id, { password: "first", account: "  demo  " });

  let environment = await store.updateData(a.id, { password: "" });
  assert.equal(environment.passwordConfigured, false);
  assert.equal((await store.readData(a.id)).password, "");

  environment = await store.updateData(a.id, { password: "second" });
  assert.equal(environment.passwordConfigured, true);
  assert.equal((await store.readData(a.id)).password, "second");
  assert.equal((await store.readData(a.id)).account, "  demo  ");
});

test("非法名称、地址或字段类型拒绝且不改写配置", async (t) => {
  const { store, a, storagePath } = await setup(t);
  const before = await readFile(storagePath, "utf8");
  const invalidInputs = [
    { name: "" },
    { name: "x".repeat(41) },
    { name: 42 },
    { address: "ftp://example.invalid" },
    { address: "https://user:pass@example.invalid" },
    { address: 42 },
    { account: 42 },
    { password: 42 },
    null,
    [],
  ];

  for (const input of invalidInputs) {
    await assert.rejects(store.updateData(a.id, input));
    assert.equal(await readFile(storagePath, "utf8"), before);
  }
});

test("删除项目环境只移除配置，不删除工作目录或影响其他记录", async (t) => {
  const { store, a, b, first } = await setup(t);
  const removed = await store.remove(a.id);
  assert.deepEqual(removed, { id: a.id, name: a.name });

  const environments = await store.listEnvironments();
  assert.deepEqual(environments.map((item) => item.id), [b.id]);
  await assert.rejects(store.readData(a.id), /未找到该项目/);
  assert.equal((await stat(first)).isDirectory(), true);
  await assert.rejects(store.remove("missing"));
});

test("环境更新保留工作目录和编号", async (t) => {
  const { store, a } = await setup(t);
  const updated = await store.updateData(a.id, {
    name: "改名",
    address: "",
    account: "",
    password: "",
  });
  assert.equal(updated.id, a.id);
  assert.equal(updated.workspaceDir, a.workspaceDir);
  const data = await store.readData(a.id);
  assert.equal(data.name, "改名");
  assert.equal(data.address, "");
});
