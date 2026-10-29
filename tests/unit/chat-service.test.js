const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  createChatService,
} = require("../../src/main/services/chat-service.js");

test("初始化期间拒绝重复发送，停止后不调用模型", async () => {
  let sendCalls = 0;

  // 分别控制“已进入初始化”和“初始化完成”。
  const initializing = Promise.withResolvers();
  const initialized = Promise.withResolvers();

  const service = createChatService(
    {
      getSession() {
        initializing.resolve();

        // 暂停初始化，直到测试主动放行。
        return initialized.promise;
      },
    },
    async () => async () => {
      sendCalls += 1;
    },
  );

  const pending = service.send("你好", () => {}, () => {});

  // 确保第一条请求正处于初始化阶段。
  await initializing.promise;

  assert.equal(service.isBusy(), true);

  await assert.rejects(
    service.send("重复消息", () => {}, () => {}),
    /已有消息正在生成/,
  );

  // 初始化尚未完成时停止，然后放行初始化。
  await service.stop();
  assert.equal(service.isBusy(), true);
  initialized.resolve({});

  // 原请求应正常结束，但不能调用模型。
  assert.deepEqual(await pending, { stopped: true });
  assert.equal(sendCalls, 0);
  assert.equal(service.isBusy(), false);
});

test("请求失败后释放状态，并允许重试", async () => {
  let calls = 0;
  const received = [];

  const service = createChatService(
    { getSession: async () => ({}) },
    async () => async (_session, _text, onText) => {
      calls += 1;

      if (calls === 1) {
        throw new Error("网络错误");
      }

      onText("成功");
    },
  );

  await assert.rejects(
    service.send("你好", () => {}, () => {}),
    /网络错误/,
  );

  assert.equal(service.isBusy(), false);

  const result = await service.send(
    "重试",
    (text) => received.push(text),
    () => {},
  );

  assert.deepEqual(result, { stopped: false });
  assert.deepEqual(received, ["成功"]);
});

test("生成期间停止会调用 abort，并忽略停止后的文本", async () => {
  // 使用明确的开始和结束信号，不依赖等待时长。
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const received = [];
  let abortCalls = 0;

  const session = {
    async abort() {
      abortCalls += 1;
      finished.resolve();
    },
  };

  const service = createChatService(
    { getSession: async () => session },
    async () => async (_session, _text, onText) => {
      onText("开始");
      started.resolve();

      await finished.promise;
      onText("停止后的文本");
    },
  );

  const pending = service.send(
    "长回复",
    (text) => received.push(text),
    () => {},
  );

  await started.promise;
  await service.stop();

  assert.deepEqual(await pending, { stopped: true });
  assert.deepEqual(received, ["开始"]);
  assert.equal(abortCalls, 1);
  assert.equal(service.isBusy(), false);
});
test("工具生成的草稿被登记到实际请求会话", async () => {
  const events = [];

  const service = createChatService(
    {
      getSession: async () => ({ sessionId: "session-a" }),
    },
    async () => async (_session, _text, _onText, onToolEvent) => {
      onToolEvent({
        type: "end",
        name: "propose_workspace_edit",
        isError: false,
        proposal: {
          kind: "edit-proposal",
          path: "example.js",
          oldText: "before",
          newText: "after",
          baseTextHash: "a".repeat(64),
          written: false,
        },
      });
    },
  );

  await service.send(
    "生成草稿",
    () => {},
    (event) => events.push(event),
  );

  const proposal = events[0].proposal;

  assert.equal(proposal.sessionId, "session-a");
  assert.ok(proposal.id);
  assert.deepEqual(await service.getProposal(proposal.id), proposal);
});

test("草稿列表跟随当前会话切换，保存后不再列出", async () => {
  let sessionId = "session-a";
  const received = [];
  const service = createChatService(
    { getSession: async () => ({ sessionId }) },
    async () => async (_session, _text, _onText, onToolEvent) => {
      onToolEvent({
        type: "end",
        name: "propose_workspace_edit",
        isError: false,
        proposal: {
          kind: "edit-proposal",
          path: "example.js",
          oldText: "before",
          newText: "after",
          baseTextHash: "a".repeat(64),
          written: false,
        },
      });
    },
  );
  const onToolEvent = (event) => received.push(event.proposal);

  await service.send("生成 A 草稿", () => {}, onToolEvent);
  const first = received[0];

  sessionId = "session-b";
  assert.deepEqual(await service.listProposals(), []);
  await service.send("生成 B 草稿", () => {}, onToolEvent);
  const second = received[1];
  assert.deepEqual(await service.listProposals(), [
    { id: second.id, path: second.path },
  ]);

  sessionId = "session-a";
  assert.deepEqual(await service.listProposals(), [
    { id: first.id, path: first.path },
  ]);
  service.markProposalWritten("session-a", first.id);
  assert.deepEqual(await service.listProposals(), []);
});
