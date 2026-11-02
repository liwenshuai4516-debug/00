const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const path = require("node:path");
const { runInNewContext } = require("node:vm");
const { createProjectService } = require("../../src/main/services/project-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

test("重命名仅委托存储，等待落盘并返回实际名称，不操作会话或目录", async () => {
  const saved = Promise.withResolvers();
  const result = { id: "p", name: "新名称", workspaceDir: "/demo" };
  const service = createProjectService({
    rename(...args) { assert.deepEqual(args, ["p", " 新名称 "]); return saved.promise; },
  }, () => assert.fail("不选择目录"), { openWorkspace: () => assert.fail("不切换会话") });
  let finished = false;
  const pending = service.renameProject("p", " 新名称 ").then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  saved.resolve(result);
  assert.equal(await pending, result);
  const error = new Error("保存失败");
  const failed = createProjectService({ rename: async () => { throw error; } });
  await assert.rejects(failed.renameProject("p", "名称"), actual => actual === error);
});

for (const fail of [false, true]) {
  test(`重命名共用操作锁，${fail ? "失败" : "成功"}后释放；输入保存和停止仍可用`, async () => {
    const handlers = new Map();
    const saving = Promise.withResolvers();
    const started = Promise.withResolvers();
    let busy = true, newChats = 0, writes = 0;
    registerAgentIpc({ handle: (name, handler) => handlers.set(name, handler) }, {
      newChat: () => { newChats++; },
    }, { isBusy: () => busy, stop: () => "stopped" }, {}, {}, {}, {}, {
      renameProject(...args) {
        assert.deepEqual(args, ["p", "名称"]);
        started.resolve(); return saving.promise;
      },
    }, { saveDraft: () => { writes++; } });
    const rename = handlers.get("agent:rename-project");
    assert.equal(typeof rename, "function");
    assert.throws(() => rename({}, "p", "名称"), /请等待/);
    busy = false;
    const pending = rename({}, "p", "名称", "/forged");
    await started.promise;
    for (const name of ["agent:rename-project", "agent:add-project", "agent:open-project", "agent:new-chat", "agent:apply-proposal"]) {
      assert.throws(() => handlers.get(name)({}, "p", "名称"), /其他操作完成/);
    }
    assert.throws(() => handlers.get("agent:send-message")({}, "你好"), /当前操作结束/);
    assert.equal(handlers.get("agent:stop")({}), "stopped");
    handlers.get("agent:save-composer-draft")({}, "s", "输入", 0);
    assert.equal(writes, 1);
    if (fail) {
      const rejected = assert.rejects(pending, /写入失败/);
      saving.reject(new Error("写入失败")); await rejected;
    } else {
      saving.resolve({ id: "p", name: "名称" });
      assert.deepEqual(await pending, { id: "p", name: "名称" });
    }
    await handlers.get("agent:new-chat")({}); assert.equal(newChats, 1);
  });
}

test("预加载重命名只转发固定通道、编号与名称", async () => {
  let agent;
  const calls = [];
  runInNewContext(readFileSync(path.join(__dirname, "../../src/preload/preload.js"), "utf8"), {
    require: () => ({
      contextBridge: { exposeInMainWorld: (_name, value) => { agent = value; } },
      ipcRenderer: { invoke: (...args) => { calls.push(args); return Promise.resolve(); } },
    }),
  });
  assert.equal(typeof agent.renameProject, "function");
  await agent.renameProject("p", "名称", "/forged");
  assert.deepEqual(calls, [["agent:rename-project", "p", "名称"]]);
});
