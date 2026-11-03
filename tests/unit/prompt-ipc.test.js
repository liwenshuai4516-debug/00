const { test } = require("node:test");
const assert = require("node:assert/strict");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");

test("提示词接口限制参数，保存与会话读取共用互斥，失败后释放", async () => {
  const handlers = new Map();
  let busy = false, release;
  let received;
  const snapshot = { version: 1, revision: 0, testAgentPrompt: "当前职责", origin: "new" };
  const settings = { version: 1, revision: 1, testAgentPrompt: "默认职责" };
  const store = {
    read: async () => settings,
    save: async (text, revision) => {
      received = [text, revision];
      await new Promise(resolve => { release = resolve; });
      return { version: 1, revision: 2, testAgentPrompt: text };
    },
  };
  registerAgentIpc(
    { handle: (name, action) => handlers.set(name, action) },
    { getSession: async () => ({ sessionId: "a", desktopPromptSnapshot: snapshot }) },
    { isBusy: () => busy }, {}, {}, {}, {}, {}, {}, {}, store,
  );
  const call = (name, ...args) => handlers.get(`agent:${name}`)({}, ...args);
  const { AGENT_SYSTEM_PROMPT } = await import("../../src/main/prompts/agent-system-prompt.mjs");
  assert.equal((await call("read-prompt-settings")).basePrompt, AGENT_SYSTEM_PROMPT);
  busy = true;
  assert.throws(() => call("save-prompt-settings", { testAgentPrompt: "新职责" }, 1), /请等待/);
  busy = false;
  const saving = call("save-prompt-settings", {
    testAgentPrompt: "新职责", basePrompt: "不得接收", sessionId: "不得接收",
  }, 1);
  await Promise.resolve();
  assert.throws(() => call("session-prompt-info"), /请等待/);
  assert.deepEqual(received, ["新职责", 1]);
  release();
  await saving;
  assert.equal((await call("session-prompt-info")).testAgentPrompt, "当前职责");
  store.save = async () => { throw new Error("模拟失败"); };
  await assert.rejects(call("save-prompt-settings", { testAgentPrompt: "另一个职责" }, 2), /模拟失败/);
  assert.equal((await call("session-prompt-info")).revision, 0);
});
