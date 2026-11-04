const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { createSessionService } = require("../../src/main/services/session-service.js");

function makeSession(id, calls, gate) {
  const entries = [];
  return {
    sessionId: id,
    desktopSessionOrigin: "empty",
    model: { provider: "mock", id: "mock" },
    sessionManager: {
      getCwd: () => "/tmp/workspace",
      getEntries: () => entries,
      getBranch: () => [],
      buildSessionContext: () => ({ model: undefined, messages: [] }),
      getSessionId: () => id,
      getSessionFile: () => `/tmp/${id}.jsonl`,
    },
    async abort() {
      calls.push(`${id}:abort`);
    },
    extensionRunner: {
      async emit(event) {
        calls.push(`${id}:shutdown:${event.reason}`);
        if (gate) await gate.promise;
      },
    },
    settingsManager: {
      async flush() {
        calls.push(`${id}:flush`);
      },
    },
    dispose() {
      calls.push(`${id}:dispose`);
    },
  };
}

test("新建对话先返回新会话，旧会话清理在后台完成", async () => {
  const calls = [];
  const closeGate = Promise.withResolvers();
  let serial = 0;
  const service = createSessionService(
    path.join(os.tmpdir(), "unused-sessions"),
    async () => makeSession(`session-${++serial}`, calls, serial === 1 ? closeGate : null),
    async () => "/tmp/workspace",
  );

  const first = await service.getSession();
  assert.equal(first.sessionId, "session-1");

  const nextId = await Promise.race([
    service.newChat(),
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error("newChat 仍在等待旧会话清理")), 500);
    }),
  ]);
  assert.equal(nextId, "session-2");
  assert.deepEqual(calls, [
    "session-1:abort",
    "session-1:shutdown:new",
  ]);

  // 关闭应用时必须等待后台清理和当前会话一起收尾。
  let closed = false;
  const closing = service.closeSession().then(() => {
    closed = true;
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(closed, false);
  closeGate.resolve();
  await closing;
  assert.equal(closed, true);
  assert.deepEqual(calls, [
    "session-1:abort",
    "session-1:shutdown:new",
    "session-1:flush",
    "session-1:dispose",
    "session-2:abort",
    "session-2:shutdown:quit",
    "session-2:flush",
    "session-2:dispose",
  ]);
});
