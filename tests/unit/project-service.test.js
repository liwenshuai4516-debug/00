const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const { createProjectService } = require("../../src/main/services/project-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

const directory = path.join(os.tmpdir(), "selected-project");
const project = { id: "p1", name: "项目", workspaceDir: directory };

test("只登记系统选择的目录，等待保存完成后才返回项目", async () => {
  const sender = {};
  const saving = Promise.withResolvers();
  const saved = Promise.withResolvers();
  const service = createProjectService(
    {
      add(value) {
        assert.equal(value, directory);
        saving.resolve();
        return saved.promise;
      },
      list: async () => [project],
    },
    async (actualSender, options) => {
      assert.equal(actualSender, sender);
      assert.deepEqual(options, {
        title: "添加项目",
        buttonLabel: "添加项目",
        properties: ["openDirectory"],
      });
      return { canceled: false, filePaths: [directory] };
    },
  );

  let completed = false;
  const pending = service.addProject(sender, "/forged").then((result) => {
    completed = true;
    return result;
  });
  await saving.promise;
  assert.equal(completed, false);
  saved.resolve(project);
  assert.deepEqual(await pending, { canceled: false, project });
  assert.deepEqual(await service.listProjects(), [project]);
});

test("取消或没有选中目录不登记项目", async () => {
  for (const selection of [
    { canceled: true, filePaths: [directory] },
    { canceled: false, filePaths: [] },
    { canceled: false },
  ]) {
    const service = createProjectService(
      { add() { assert.fail("取消后不能保存项目"); } },
      async () => selection,
    );
    assert.deepEqual(await service.addProject({}), { canceled: true });
  }
});

test("窗口、保存及列表读取失败时返回原错误", async () => {
  const failedDialog = createProjectService(
    { add() { assert.fail("窗口失败不能保存"); } },
    async () => { throw new Error("窗口失败"); },
  );
  await assert.rejects(failedDialog.addProject({}), /窗口失败/);

  const failedStore = createProjectService(
    {
      async add() { throw new Error("保存失败"); },
      async list() { throw new Error("读取失败"); },
    },
    async () => ({ canceled: false, filePaths: [directory] }),
  );
  await assert.rejects(failedStore.addProject({}), /保存失败/);
  await assert.rejects(failedStore.listProjects(), /读取失败/);
});

for (const fail of [false, true]) {
  test(`选择与登记全程互斥，${fail ? "失败" : "成功"}后恢复操作`, async () => {
    const choosing = Promise.withResolvers();
    const selected = Promise.withResolvers();
    const saving = Promise.withResolvers();
    const saved = Promise.withResolvers();
    const sender = {};
    let busy = true;
    let newChats = 0;
    const handlers = new Map();

    const service = createProjectService(
      {
        list: async () => [project],
        add(value) {
          assert.equal(value, directory);
          saving.resolve();
          return saved.promise;
        },
      },
      (actualSender) => {
        assert.equal(actualSender, sender);
        choosing.resolve();
        return selected.promise;
      },
    );

    registerAgentIpc(
      { handle: (name, handler) => handlers.set(name, handler) },
      { newChat() { newChats += 1; } },
      { isBusy: () => busy },
      {}, {}, {}, {}, service,
    );

    const add = handlers.get("agent:add-project");
    assert.throws(() => add({ sender }), /请等待当前回复结束/);
    busy = false;
    const pending = add({ sender }, "/forged");
    await choosing.promise;

    function assertBlocked() {
      for (const name of [
        "agent:add-project", "agent:select-workspace", "agent:new-chat",
        "agent:open-session", "agent:switch-model", "agent:compact-session",
        "agent:apply-proposal", "agent:discard-proposal",
      ]) {
        assert.throws(
          () => handlers.get(name)({ sender }, "value"),
          /其他操作完成/,
        );
      }
      assert.throws(
        () => handlers.get("agent:send-message")({ sender }, "你好"),
        /当前操作结束/,
      );
    }

    assertBlocked();
    selected.resolve({ canceled: false, filePaths: [directory] });
    await saving.promise;
    assertBlocked();

    // 只读列表在登记期间仍可读取；添加本身没有新建会话。
    assert.deepEqual(await handlers.get("agent:list-projects")({}), [project]);
    assert.equal(newChats, 0);

    if (fail) {
      const rejected = assert.rejects(pending, /保存失败/);
      saved.reject(new Error("保存失败"));
      await rejected;
    } else {
      saved.resolve(project);
      assert.deepEqual(await pending, { canceled: false, project });
    }

    await handlers.get("agent:new-chat")({});
    assert.equal(newChats, 1);
  });
}

test("预加载项目接口只调用固定通道，不转发路径参数", async () => {
  let agent;
  const calls = [];
  const electron = {
    contextBridge: {
      exposeInMainWorld(_name, value) { agent = value; },
    },
    ipcRenderer: {
      invoke(...args) {
        calls.push(args);
        return Promise.resolve();
      },
    },
  };

  runInNewContext(
    readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"),
    {
      require(name) {
        assert.equal(name, "electron");
        return electron;
      },
    },
  );

  await agent.listProjects("/forged");
  await agent.addProject("/forged");
  assert.deepEqual(calls, [
    ["agent:list-projects"],
    ["agent:add-project"],
  ]);
});
