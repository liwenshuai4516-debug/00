const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, realpath, symlink, writeFile, rm,
} = require("node:fs/promises");
const {
  createSessionService,
} = require("../../src/main/services/session-service.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-open-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "first"));
  await mkdir(path.join(base, "second"));
  const first = await realpath(path.join(base, "first"));
  const second = await realpath(path.join(base, "second"));
  const alias = path.join(base, "alias");
  await symlink(first, alias, "dir");

  const state = {
    base, first, second, alias, selected: first,
    calls: [], sessions: [], events: [],
    failRead: false, failCreate: false, failSave: false, failHistory: false,
  };

  state.service = createSessionService(
    "unused",
    async (...args) => {
      state.calls.push(args);
      if (state.failCreate) throw new Error("恢复失败");
      const session = {
        sessionId: `session-${state.sessions.length + 1}`,
        sessionManager: { getCwd: () => args[3] },
        get messages() {
          if (state.failHistory) throw new Error("历史读取失败");
          return [{ role: "user", content: "项目消息" }];
        },
        disposed: false,
        dispose() {
          this.disposed = true;
          state.events.push(`dispose:${this.sessionId}`);
        },
      };
      state.sessions.push(session);
      return session;
    },
    async () => {
      if (state.failRead) throw new Error("配置读取失败");
      return state.selected;
    },
    async (directory) => {
      // 保存完成之前，旧会话必须仍然有效。
      assert.equal(state.sessions[0].disposed, false);
      state.events.push("save");
      if (state.failSave) throw new Error("配置保存失败");
      state.selected = directory;
    },
  );
  return state;
}

test("打开其他项目请求恢复，准备完成后再保存目录和释放旧会话", async (t) => {
  const s = await setup(t);
  const original = await s.service.getSession();
  const result = await s.service.openWorkspace(s.second);
  assert.deepEqual(s.calls[1], ["unused", true, undefined, s.second]);
  assert.deepEqual(result, {
    sessionId: "session-2",
    workspaceDir: s.second,
    history: [{ role: "user", text: "项目消息" }],
  });
  assert.equal(await s.service.getSession(), s.sessions[1]);
  assert.equal(s.selected, s.second);
  assert.equal(original.disposed, true);
  assert.deepEqual(s.events, ["save", "dispose:session-1"]);
});

test("当前项目的符号链接别名保留原会话，不创建或再次保存", async (t) => {
  const s = await setup(t);
  const original = await s.service.getSession();
  const result = await s.service.openWorkspace(s.alias);
  assert.equal(result.sessionId, original.sessionId);
  assert.equal(result.workspaceDir, s.first);
  assert.equal(await s.service.getSession(), original);
  assert.equal(s.calls.length, 1);
  assert.equal(original.disposed, false);
  assert.deepEqual(s.events, []);
});

for (const [flag, message, creates] of [
  ["failCreate", "恢复失败", 1],
  ["failSave", "配置保存失败", 2],
  ["failHistory", "历史读取失败", 2],
]) {
  test(`${message}时保留旧会话和目录，释放已创建的候选`, async (t) => {
    const s = await setup(t);
    const original = await s.service.getSession();
    s[flag] = true;
    await assert.rejects(s.service.openWorkspace(s.second), new RegExp(message));
    assert.equal(await s.service.getSession(), original);
    assert.equal(original.disposed, false);
    assert.equal(s.selected, s.first);
    assert.equal(s.sessions.length, creates);
    if (creates === 2) assert.equal(s.sessions[1].disposed, true);
    if (flag === "failHistory") {
      assert.deepEqual(s.events, ["dispose:session-2"]);
    }
  });
}

for (const initialize of [false, true]) {
  test(`原配置不可读时仍可打开指定项目（已有初始化：${initialize}）`, async (t) => {
    const s = await setup(t);
    s.failRead = true;
    if (initialize) {
      await assert.rejects(s.service.getSession(true), /配置读取失败/);
    }
    const result = await s.service.openWorkspace(s.second);
    assert.equal(result.workspaceDir, s.second);
    assert.equal(s.selected, s.second);
    assert.deepEqual(s.calls, [["unused", true, undefined, s.second]]);
  });
}

test("不存在的目录或普通文件不改变当前会话和目录", async (t) => {
  const s = await setup(t);
  const original = await s.service.getSession();
  const file = path.join(s.base, "file.txt");
  await writeFile(file, "临时测试内容");
  await assert.rejects(s.service.openWorkspace(path.join(s.base, "missing")));
  await assert.rejects(s.service.openWorkspace(file), /项目路径必须指向文件夹/);
  assert.equal(await s.service.getSession(), original);
  assert.equal(original.disposed, false);
  assert.equal(s.selected, s.first);
  assert.equal(s.calls.length, 1);
  assert.deepEqual(s.events, []);
});

test("缺少目录保存方法时拒绝，不创建会话", async () => {
  let creates = 0;
  const service = createSessionService("unused", async () => { creates += 1; });
  await assert.rejects(service.openWorkspace("/unused"), /尚未配置工作目录保存方法/);
  assert.equal(creates, 0);
});