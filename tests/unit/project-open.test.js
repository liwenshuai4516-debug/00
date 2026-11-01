const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { createProjectService } = require("../../src/main/services/project-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

const project = {
  id: "p1", name: "测试项目",
  workspaceDir: path.join(os.tmpdir(), "registered-project"),
};
const result = {
  sessionId: "s1", workspaceDir: project.workspaceDir,
  history: [{ role: "user", text: "项目历史" }],
};

test("按编号查登记目录，等待会话恢复完成，不转发页面路径", async () => {
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const service = createProjectService(
    { list: async () => [project] },
    () => assert.fail("打开项目不弹选择窗口"),
    {
      openWorkspace(...args) {
        assert.deepEqual(args, [project.workspaceDir]);
        started.resolve();
        return finished.promise;
      },
    },
  );
  let completed = false;
  const pending = service.openProject("p1", "/forged").then((value) => {
    completed = true;
    return value;
  });
  await started.promise;
  assert.equal(completed, false);
  finished.resolve(result);
  assert.deepEqual(await pending, result);
});

test("空编号、对象、未知编号或路径不能打开目录", async () => {
  const service = createProjectService(
    { list: async () => [project] },
    undefined,
    { openWorkspace: () => assert.fail("无效编号不能进入会话服务") },
  );
  for (const id of [undefined, null, "", "  ", 1, {}, ["p1"]]) {
    await assert.rejects(service.openProject(id), /请选择项目/);
  }
  for (const id of ["unknown", project.workspaceDir]) {
    await assert.rejects(service.openProject(id), /未找到该项目/);
  }
});

test("项目列表读取失败不打开目录", async () => {
  const service = createProjectService(
    { async list() { throw new Error("项目读取失败"); } },
    undefined,
    { openWorkspace: () => assert.fail("读取失败不能切换") },
  );
  await assert.rejects(service.openProject("p1"), /项目读取失败/);
});

test("会话恢复失败返回原错误", async () => {
  const service = createProjectService(
    { list: async () => [project] },
    undefined,
    { async openWorkspace() { throw new Error("恢复失败"); } },
  );
  await assert.rejects(service.openProject("p1"), /恢复失败/);
});

for (const fail of [false, true]) {
  test(`打开项目全程互斥，${fail ? "失败" : "成功"}后释放状态`, async () => {
    const handlers = new Map();
    const started = Promise.withResolvers();
    const finished = Promise.withResolvers();
    let busy = true;
    let opens = 0;
    let newChats = 0;
    registerAgentIpc(
      { handle: (name, handler) => handlers.set(name, handler) },
      { newChat() { newChats += 1; } },
      { isBusy: () => busy },
      {}, {}, {}, {},
      {
        listProjects: async () => [project],
        openProject(...args) {
          assert.deepEqual(args, ["p1"]);
          opens += 1;
          started.resolve();
          return finished.promise;
        },
      },
    );
    const open = handlers.get("agent:open-project");
    assert.throws(() => open({}, "p1"), /请等待当前回复结束/);
    assert.equal(opens, 0);
    busy = false;
    const pending = open({}, "p1", "/forged");
    await started.promise;

    for (const name of [
      "agent:open-project", "agent:add-project", "agent:select-workspace",
      "agent:open-session", "agent:new-chat", "agent:switch-model",
      "agent:compact-session", "agent:export-conversation",
      "agent:apply-proposal", "agent:discard-proposal",
    ]) {
      assert.throws(() => handlers.get(name)({}, "value"), /其他操作完成/);
    }
    assert.throws(
      () => handlers.get("agent:send-message")({}, "你好"),
      /当前操作结束/,
    );
    assert.deepEqual(await handlers.get("agent:list-projects")({}), [project]);
    assert.equal(opens, 1);

    if (fail) {
      const rejected = assert.rejects(pending, /打开失败/);
      finished.reject(new Error("打开失败"));
      await rejected;
    } else {
      finished.resolve(result);
      assert.deepEqual(await pending, result);
    }
    await handlers.get("agent:new-chat")({});
    assert.equal(newChats, 1);
  });
}

test("保存期间拒绝打开项目，保存结束后正常转发", async () => {
  const handlers = new Map();
  const finished = Promise.withResolvers();
  let opens = 0;
  registerAgentIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    {}, { isBusy: () => false }, {},
    { apply: () => finished.promise },
    {}, {},
    { openProject() { opens += 1; return result; } },
  );
  const pending = handlers.get("agent:apply-proposal")({}, "draft1");
  const open = handlers.get("agent:open-project");
  assert.throws(() => open({}, "p1"), /其他操作完成/);
  assert.equal(opens, 0);
  finished.resolve();
  await pending;
  assert.deepEqual(await open({}, "p1"), result);
  assert.equal(opens, 1);
});

test("预加载打开项目只转发编号和固定通道", async () => {
  let agent;
  const calls = [];
  runInNewContext(
    readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"),
    {
      require(name) {
        assert.equal(name, "electron");
        return {
          contextBridge: { exposeInMainWorld(_name, value) { agent = value; } },
          ipcRenderer: { invoke(...args) { calls.push(args); return Promise.resolve(); } },
        };
      },
    },
  );
  await agent.openProject("p1", "/forged");
  assert.deepEqual(calls, [["agent:open-project", "p1"]]);
});