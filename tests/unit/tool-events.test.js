const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createChatService } = require(
  "../../src/main/services/chat-service.js"
);

test("同名工具交错完成时，事件保留各自调用编号", async () => {
  const { sendMessage } = await import("../../src/main/pi-agent.mjs");
  const received = [];
  let listener;
  let unsubscribeCalls = 0;

  const session = {
    agent: { state: {} },

    subscribe(callback) {
      listener = callback;
      return () => { unsubscribeCalls += 1; };
    },

    async prompt() {
      // 同名调用按相反顺序完成，验证不能依赖名称或顺序。
      for (const id of ["call-a", "call-b"]) {
        listener({
          type: "tool_execution_start",
          toolCallId: id,
          toolName: "read_workspace_text_file",
        });
      }

      for (const id of ["call-b", "call-a"]) {
        listener({
          type: "tool_execution_end",
          toolCallId: id,
          toolName: "read_workspace_text_file",
          isError: false,
          result: {
            content: [{ type: "text", text: id }],
          },
        });
      }
    },
  };

  await sendMessage(
    session,
    "测试",
    () => {},
    (event) => received.push(event),
  );

  assert.deepEqual(
    received.map((event) => [event.type, event.toolCallId]),
    [
      ["start", "call-a"],
      ["start", "call-b"],
      ["end", "call-b"],
      ["end", "call-a"],
    ],
  );

  assert.equal(unsubscribeCalls, 1);
});

test("请求异常时仍取消 Pi 事件订阅", async () => {
  const { sendMessage } = await import("../../src/main/pi-agent.mjs");
  let unsubscribeCalls = 0;

  const session = {
    subscribe() {
      return () => { unsubscribeCalls += 1; };
    },

    async prompt() {
      throw new Error("请求失败");
    },
  };

  await assert.rejects(
    sendMessage(session, "测试", () => {}, () => {}),
    /请求失败/,
  );

  assert.equal(unsubscribeCalls, 1);
});

test("草稿登记失败时，错误事件仍关联原工具调用", async () => {
  const events = [];

  const service = createChatService(
    { getSession: async () => ({ sessionId: "session-a" }) },

    async () => async (_session, _text, _onText, onToolEvent) => {
      onToolEvent({
        type: "end",
        toolCallId: "proposal-call",
        name: "propose_workspace_edit",
        isError: false,
        proposal: {},
      });
    },

    {
      add() {
        throw new Error("快照写入失败");
      },
    },
  );

  await service.send(
    "生成草稿",
    () => {},
    (event) => events.push(event),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].toolCallId, "proposal-call");
  assert.equal(events[0].isError, true);
  assert.equal(events[0].proposal, undefined);
  assert.match(events[0].text, /草稿未登记/);
});