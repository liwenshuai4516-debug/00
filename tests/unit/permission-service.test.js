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
  assert.equal(settings.scope, "default");
  assert.equal(settings.defaultMode, "ask");
  assert.deepEqual(settings.options.map((item) => item.id), ["ask", "read-only", "full-access"]);
  assert.equal(service.currentMode(), "ask");
});

test("会话权限优先，项目范围覆盖同工作区其他会话，默认只影响新会话", async (t) => {
  const { service, file } = await setup(t);
  const workspace = "/workspace/project-a";

  await service.save({
    mode: "read-only",
    scope: "session",
    sessionId: "session-a",
    workspace,
  });
  assert.equal(service.currentMode({ sessionId: "session-a", workspace }), "read-only");
  assert.equal(service.currentMode({ sessionId: "session-b", workspace }), "ask");
  assert.deepEqual(service.settings({ sessionId: "session-a", workspace }).scope, "session");

  await service.save({
    mode: "full-access",
    scope: "workspace",
    sessionId: "session-a",
    workspace,
  });
  // 项目范围应清除当前会话的旧覆盖，否则选择项目范围不会生效。
  assert.equal(service.currentMode({ sessionId: "session-a", workspace }), "full-access");
  assert.equal(service.currentMode({ sessionId: "session-b", workspace }), "full-access");
  assert.equal(service.currentMode({ sessionId: "session-b", workspace: "/workspace/project-b" }), "ask");
  assert.deepEqual(service.settings({ sessionId: "session-b", workspace }).scope, "workspace");

  await service.save({ mode: "read-only", scope: "default" });
  assert.equal(service.currentMode({ sessionId: "session-b", workspace }), "full-access");
  assert.equal(service.currentMode({ sessionId: "session-b", workspace: "/workspace/project-b" }), "read-only");

  assert.deepEqual(JSON.parse(await fs.readFile(file, "utf8")), {
    version: 2,
    defaultMode: "read-only",
    sessions: {},
    workspaces: { [workspace]: "full-access" },
  });
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
});

test("会话覆盖优先于项目范围", async (t) => {
  const { service } = await setup(t);
  const workspace = "/workspace/project-a";
  await service.save({ mode: "read-only", scope: "workspace", workspace });
  await service.save({ mode: "full-access", scope: "session", sessionId: "session-a", workspace });
  assert.equal(service.currentMode({ sessionId: "session-a", workspace }), "full-access");
  assert.equal(service.currentMode({ sessionId: "session-b", workspace }), "read-only");
});

test("兼容旧版单模式文件，保存后升级为 v2", async (t) => {
  const { file } = await setup(t);
  await fs.writeFile(file, JSON.stringify({ version: 1, mode: "full-access" }), "utf8");
  const service = createPermissionService(file);
  assert.equal(service.currentMode(), "full-access");
  assert.equal(service.settings().scope, "default");

  await service.save({ mode: "ask", scope: "session", sessionId: "session-a", workspace: "/ws" });
  const saved = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(saved.version, 2);
  assert.equal(saved.defaultMode, "full-access");
  assert.deepEqual(saved.sessions, { "session-a": "ask" });
});

test("未知模式、范围或缺少会话上下文不写入", async (t) => {
  const { service, file } = await setup(t);
  await assert.rejects(service.save({ mode: "unknown", scope: "session", sessionId: "s" }), /权限模式无效/);
  await assert.rejects(service.save({ mode: "ask", scope: "unknown", sessionId: "s" }), /权限范围无效/);
  await assert.rejects(service.save({ mode: "ask", scope: "session" }), /未取得当前会话/);
  await assert.rejects(service.save({ mode: "ask", scope: "workspace" }), /未取得当前项目工作区/);
  assert.equal(service.currentMode(), "ask");
  await assert.rejects(fs.stat(file), { code: "ENOENT" });
});

test("损坏文件回到安全默认且不自动覆盖", async (t) => {
  const { file } = await setup(t);
  await fs.writeFile(file, "{ broken", "utf8");
  const service = createPermissionService(file);
  assert.equal(service.currentMode(), "ask");
  assert.equal(await fs.readFile(file, "utf8"), "{ broken");
});
