const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createPermissionService } = require("../../src/main/services/permission-service.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "permission-settings-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const file = path.join(root, "permission-settings.json");
  return { root, file, service: createPermissionService(file) };
}

test("默认每次确认，并提供三种模式", async (t) => {
  const { service } = await setup(t);
  const settings = service.settings();
  assert.equal(settings.mode, "ask");
  assert.deepEqual(settings.options.map((item) => item.id), ["ask", "read-only", "full-access"]);
  assert.equal(service.currentMode(), "ask");
});

test("保存只读或完全权限后立即影响当前模式并持久化", async (t) => {
  const { service, file } = await setup(t);
  const saved = await service.save("read-only");
  assert.equal(saved.mode, "read-only");
  assert.equal(service.currentMode(), "read-only");
  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), { version: 1, mode: "read-only" });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);

  await service.save("full-access");
  assert.equal(service.currentMode(), "full-access");
  assert.equal(createPermissionService(file).currentMode(), "full-access");
});

test("未知模式不写入，损坏文件回到安全默认且不自动覆盖", async (t) => {
  const { service, file } = await setup(t);
  await assert.rejects(service.save("unknown"), /权限模式无效/);
  assert.equal(service.currentMode(), "ask");

  await fs.writeFile(file, "{ broken", "utf8");
  const reloaded = createPermissionService(file);
  assert.equal(reloaded.currentMode(), "ask");
  assert.equal(await fs.readFile(file, "utf8"), "{ broken");
});
