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

test("新建与修改草稿通过完整事件链路登记，错误与类型错配不登记", async () => {
  const { sendMessage } = await import("../../src/main/pi-agent.mjs");
  const cases = [
    ["propose_workspace_edit", "edit-proposal", false, true],
    ["propose_workspace_create", "create-proposal", false, true],
    ["propose_workspace_edit", "create-proposal", false, false],
    ["propose_workspace_create", "edit-proposal", false, false],
    ["propose_workspace_create", "create-proposal", true, false],
    ["read_workspace_text_file", "create-proposal", false, false],
  ];

  for (const [name, kind, isError, shouldRegister] of cases) {
    const events = [];
    let listener;
    let unsubscribed = 0;

    const draft = {
      id: "tool-provided-id",
      sessionId: "tool-provided-session",
      kind,
      path: "hello.txt",
      content: "你好\n",
      oldText: "before",
      newText: "after",
      baseTextHash: "a".repeat(64),
      written: false,
    };

    const session = {
      sessionId: "session-a",
      agent: { state: {} },

      subscribe(callback) {
        listener = callback;
        return () => { unsubscribed += 1; };
      },

      async prompt() {
        // 模拟 SDK 事件，不请求模型，也不创建工作文件。
        listener({
          type: "tool_execution_start",
          toolCallId: "call-1",
          toolName: name,
        });

        listener({
          type: "tool_execution_end",
          toolCallId: "call-1",
          toolName: name,
          isError,
          result: {
            content: [{ type: "text", text: "工具结果" }],
            details: draft,
          },
        });
      },
    };

    const service = createChatService(
      { getSession: async () => session },
      async () => sendMessage,
    );

    await service.send("测试", () => {}, (event) => events.push(event));

    assert.deepEqual(events.map((event) => [event.type, event.toolCallId]), [
      ["start", "call-1"], ["end", "call-1"],
    ]);

    const end = events[1];
    assert.equal(end.isError, isError);

    if (shouldRegister) {
      assert.notEqual(end.proposal.id, draft.id);
      assert.equal(end.proposal.sessionId, "session-a");
      assert.equal(end.proposal.kind, kind);

      if (kind === "create-proposal") {
        assert.equal(end.proposal.content, draft.content);
      }

      assert.deepEqual(await service.getProposal(end.proposal.id), end.proposal);
      assert.deepEqual(await service.listProposals(), [
        { id: end.proposal.id, path: draft.path },
      ]);
    } else {
      assert.equal(end.proposal, undefined);
      assert.deepEqual(await service.listProposals(), []);
    }

    assert.equal(unsubscribed, 1);
    assert.equal(service.isBusy(), false);
  }
});

test("新建草稿登记失败仍关联原工具编号", async () => {
  const events = [];

  const service = createChatService(
    { getSession: async () => ({ sessionId: "session-a" }) },

    async () => async (_session, _text, _onText, onToolEvent) => {
      onToolEvent({
        type: "end",
        toolCallId: "create-call",
        name: "propose_workspace_create",
        isError: false,
        proposal: {
          kind: "create-proposal",
          path: "hello.txt",
          content: "",
          written: false,
        },
      });
    },

    {
      add() {
        throw new Error("模拟快照写入失败");
      },
    },
  );

  await service.send(
    "生成新建草稿",
    () => {},
    (event) => events.push(event),
  );

  assert.equal(events.length, 1);
  assert.equal(events[0].toolCallId, "create-call");
  assert.equal(events[0].isError, true);
  assert.equal(events[0].proposal, undefined);
  assert.match(events[0].text, /草稿未登记/);
  assert.equal(service.isBusy(), false);
});