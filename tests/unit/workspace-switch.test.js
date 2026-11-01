const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, realpath, symlink, rm,
} = require("node:fs/promises");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");
const {
  createWorkspaceSettings,
} = require("../../src/main/storage/workspace-settings.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-switch-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "first"));
  await mkdir(path.join(base, "second"));
  const first = await realpath(path.join(base, "first"));
  const second = await realpath(path.join(base, "second"));
  const alias = path.join(base, "selected");
  await symlink(second, alias, "dir");

  const settingsPath = path.join(base, "workspace.json");
  const settings = createWorkspaceSettings(settingsPath, first);
  await settings.save(first);

  const state = {
    first, second, alias, settings, settingsPath,
    sessions: [],
    calls: [],
    events: [],
    reads: 0,
    failRead: false,
    failCreate: false,
    failSave: false,
    beforeSave: async () => {},
  };

  // 只模拟 Agent；目录配置使用真实模块和临时文件。
  state.createAgent = async (...args) => {
    state.calls.push(args);
    state.events.push("create");
    if (state.failCreate) throw new Error("创建失败");
    const cwd = await realpath(args[3]);
    const session = {
      sessionId: `session-${state.sessions.length + 1}`,
      messages: [],
      sessionManager: { getCwd: () => cwd },
      disposed: false,
      dispose() {
        this.disposed = true;
        state.events.push(`dispose:${this.sessionId}`);
      },
    };
    state.sessions.push(session);
    return session;
  };

  state.service = createSessionService(
    "unused",
    state.createAgent,
    async () => {
      state.reads += 1;
      if (state.failRead) throw new Error("读取失败");
      return settings.load();
    },
    async (workspaceDir) => {
      state.events.push("save");
      await state.beforeSave(workspaceDir);
      if (state.failSave) throw new Error("保存失败");
      return settings.save(workspaceDir);
    },
  );

  return state;
}

test("切换先创建并保存真实目录，再替换和释放旧会话；重建服务恢复选择", async (t) => {
  const state = await setup(t);
  const original = await state.service.getSession();
  state.events.length = 0;
  state.beforeSave = async (directory) => {
    assert.equal(directory, state.second);
    assert.equal(await state.service.getSession(), original);
    assert.equal(original.disposed, false);
  };

  const result = await state.service.switchWorkspace(state.alias);
  const next = state.sessions[1];
  assert.deepEqual(result, {
    sessionId: next.sessionId,
    workspaceDir: state.second,
  });
  assert.equal(await state.service.getSession(), next);
  assert.equal(original.disposed, true);
  assert.equal(next.disposed, false);
  assert.deepEqual(state.events, ["create", "save", "dispose:session-1"]);
  assert.deepEqual(state.calls[1], ["unused", false, undefined, state.alias]);

  // 模拟重新启动：重新读取同一份临时配置，不沿用页面内存。
  const restoredSettings = createWorkspaceSettings(state.settingsPath, state.first);
  const restarted = createSessionService(
    "unused", state.createAgent, restoredSettings.load, restoredSettings.save,
  );
  const restored = await restarted.getSession(true);
  assert.equal(restored.sessionManager.getCwd(), state.second);
});

test("新会话创建失败时，不保存目录也不释放旧会话", async (t) => {
  const state = await setup(t);
  const original = await state.service.getSession();
  state.events.length = 0;
  state.failCreate = true;

  await assert.rejects(state.service.switchWorkspace(state.second), /创建失败/);
  assert.equal(await state.service.getSession(), original);
  assert.equal(original.disposed, false);
  assert.deepEqual(state.events, ["create"]);
  assert.equal(await state.settings.load(), state.first);
});

test("配置保存失败时释放新会话，旧会话和已保存选择保留", async (t) => {
  const state = await setup(t);
  const original = await state.service.getSession();
  state.events.length = 0;
  state.failSave = true;

  await assert.rejects(state.service.switchWorkspace(state.second), /保存失败/);
  assert.equal(await state.service.getSession(), original);
  assert.equal(original.disposed, false);
  assert.equal(state.sessions[1].disposed, true);
  assert.deepEqual(state.events, ["create", "save", "dispose:session-2"]);
  assert.equal(await state.settings.load(), state.first);
});

for (const initialize of [false, true]) {
  test(`原目录读取失败时仍能选择新目录（已有初始化：${initialize}）`, async (t) => {
    const state = await setup(t);
    state.failRead = true;
    let initialization;
    if (initialize) {
      initialization = assert.rejects(state.service.getSession(true), /读取失败/);
    }

    const result = await state.service.switchWorkspace(state.second);
    if (initialization) await initialization;
    assert.equal(result.workspaceDir, state.second);
    assert.equal((await state.service.getSession()).sessionId, result.sessionId);
    assert.equal(await state.settings.load(), state.second);
    assert.equal(state.reads, initialize ? 1 : 0);
  });
}

test("重复选择同一目录也新建对话，不复用原会话", async (t) => {
  const state = await setup(t);
  const original = await state.service.getSession();
  const result = await state.service.switchWorkspace(state.first);
  assert.notEqual(result.sessionId, original.sessionId);
  assert.equal(result.workspaceDir, state.first);
  assert.equal(original.disposed, true);
});

test("未接入目录保存方法时明确拒绝，不创建新会话", async () => {
  let creates = 0;
  const service = createSessionService("unused", async () => { creates += 1; });
  await assert.rejects(service.switchWorkspace("/unused"), /尚未配置工作目录保存方法/);
  assert.equal(creates, 0);
});