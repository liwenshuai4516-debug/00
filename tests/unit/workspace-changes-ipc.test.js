const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

function register(workspaceChanges) {
  const handlers = new Map();
  const ipcMain = { handle: (name, handler) => handlers.set(name, handler) };
  registerAgentIpc(
    ipcMain,
    {},
    { isBusy: () => false },
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    {},
    workspaceChanges,
  );
  return handlers;
}

test("改动摘要与差异只按主进程编号读取", async () => {
  const calls = [];
  const service = {
    summary: (requestId) => {
      calls.push(["summary", requestId]);
      return { requestId, files: [], total: 0, truncated: false };
    },
    diff: async (requestId, index) => {
      calls.push(["diff", requestId, index]);
      return { kind: "text", display: "a.txt", hunks: [] };
    },
  };
  const handlers = register(service);

  assert.deepEqual(await handlers.get("agent:read-workspace-changes")({}, "wc-1"), {
    requestId: "wc-1", files: [], total: 0, truncated: false,
  });
  assert.equal((await handlers.get("agent:read-workspace-change-diff")({}, "wc-1", 2)).kind, "text");
  assert.deepEqual(calls, [["summary", "wc-1"], ["diff", "wc-1", 2]]);
});

test("无效编号或越界下标在进入服务前被拒绝", () => {
  const handlers = register({});
  for (const value of ["", 1, null, "x".repeat(129)]) {
    assert.throws(() => handlers.get("agent:read-workspace-changes")({}, value), /改动编号无效/);
  }
  for (const index of [-1, 1.5, "0", 10001]) {
    assert.throws(
      () => handlers.get("agent:read-workspace-change-diff")({}, "wc-1", index),
      /改动文件编号无效/,
    );
  }
});

test("未接入记录服务时返回空而不抛出", async () => {
  const handlers = register(undefined);
  assert.equal(handlers.get("agent:read-workspace-changes")({}, "wc-1"), null);
  assert.equal(await handlers.get("agent:read-workspace-change-diff")({}, "wc-1", 0), null);
});
