const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  createWorkspaceSelectionService,
} = require("../../src/main/services/workspace-selection-service.js");
const {
  registerAgentIpc,
} = require("../../src/main/ipc/agent-ipc.js");

const workspaceDir = path.join(os.tmpdir(), "selected-workspace");
const expected = { sessionId: "new-session", workspaceDir };

test("只使用系统选择结果，等待切换完成后才返回成功", async () => {
  const sender = {};
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let completed = false;

  const service = createWorkspaceSelectionService(
    {
      switchWorkspace(directory) {
        assert.equal(directory, workspaceDir);
        started.resolve();
        return finished.promise;
      },
    },
    async (actualSender, options) => {
      assert.equal(actualSender, sender);
      assert.deepEqual(options, {
        title: "选择工作目录",
        buttonLabel: "选择并新建对话",
        properties: ["openDirectory"],
      });
      return { canceled: false, filePaths: [workspaceDir] };
    },
  );

  const pending = service.selectWorkspace(sender).then((result) => {
    completed = true;
    return result;
  });
  await started.promise;
  assert.equal(completed, false);
  finished.resolve(expected);
  assert.deepEqual(await pending, { canceled: false, ...expected });
});

test("取消或没有选中目录时不切换，也不初始化旧会话", async () => {
  for (const selection of [
    { canceled: true, filePaths: [workspaceDir] },
    { canceled: false, filePaths: [] },
    { canceled: false },
  ]) {
    const service = createWorkspaceSelectionService(
      {
        getSession() { assert.fail("选择目录不应初始化旧会话"); },
        switchWorkspace() { assert.fail("取消后不能切换"); },
      },
      async () => selection,
    );
    assert.deepEqual(await service.selectWorkspace({}), { canceled: true });
  }
});

test("选择窗口失败或切换失败时透传错误", async () => {
  const failedDialog = createWorkspaceSelectionService(
    { switchWorkspace() { assert.fail("窗口失败不能切换"); } },
    async () => { throw new Error("窗口失败"); },
  );
  await assert.rejects(failedDialog.selectWorkspace({}), /窗口失败/);

  const failedSwitch = createWorkspaceSelectionService(
    { async switchWorkspace() { throw new Error("切换失败"); } },
    async () => ({ canceled: false, filePaths: [workspaceDir] }),
  );
  await assert.rejects(failedSwitch.selectWorkspace({}), /切换失败/);
});

for (const outcome of ["cancel", "success", "failure"]) {
  test(`选择及切换全程互斥，${outcome} 后释放状态`, async () => {
    const handlers = new Map();
    const choosing = Promise.withResolvers();
    const selected = Promise.withResolvers();
    const switching = Promise.withResolvers();
    const finished = Promise.withResolvers();
    const sender = {};
    let busy = true;
    let newChats = 0;
    let dialogs = 0;
    let switches = 0;

    const service = createWorkspaceSelectionService(
      {
        switchWorkspace(directory) {
          assert.equal(directory, workspaceDir);
          switches += 1;
          switching.resolve();
          return finished.promise;
        },
      },
      (actualSender) => {
        assert.equal(actualSender, sender);
        dialogs += 1;
        choosing.resolve();
        return selected.promise;
      },
    );

    registerAgentIpc(
      { handle: (name, handler) => handlers.set(name, handler) },
      { newChat: () => { newChats += 1; } },
      { isBusy: () => busy },
      {},
      {},
      {},
      service,
    );

    const select = handlers.get("agent:select-workspace");
    assert.throws(() => select({ sender }), /请等待当前回复结束/);
    assert.equal(dialogs, 0);
    busy = false;

    // 额外路径参数不能替代系统窗口的选择结果。
    const pending = select({ sender }, "/forged-directory");
    await choosing.promise;

    function assertBlocked() {
      for (const name of [
        "agent:select-workspace", "agent:new-chat", "agent:open-session",
        "agent:switch-model", "agent:compact-session", "agent:export-conversation",
        "agent:get-proposal", "agent:apply-proposal", "agent:discard-proposal",
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
    if (outcome === "cancel") {
      selected.resolve({ canceled: true });
      assert.deepEqual(await pending, { canceled: true });
      assert.equal(switches, 0);
    } else {
      selected.resolve({ canceled: false, filePaths: [workspaceDir] });
      await switching.promise;
      assertBlocked();
      if (outcome === "failure") {
        const rejected = assert.rejects(pending, /切换失败/);
        finished.reject(new Error("切换失败"));
        await rejected;
      } else {
        finished.resolve(expected);
        assert.deepEqual(await pending, { canceled: false, ...expected });
      }
      assert.equal(switches, 1);
    }

    assert.equal(dialogs, 1);
    await handlers.get("agent:new-chat")({});
    assert.equal(newChats, 1);
  });
}