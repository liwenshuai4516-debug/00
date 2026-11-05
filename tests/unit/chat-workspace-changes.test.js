const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createChatService } = require("../../src/main/services/chat-service.js");

function session() {
  return {
    sessionId: "s1",
    sessionManager: { getCwd: () => "/work" },
    abort: async () => {},
  };
}

function recorder(overrides = {}) {
  const calls = [];
  const service = {
    async begin(sessionId, cwd) {
      calls.push(["begin", sessionId, cwd]);
      return { id: "wc-1", ready: Promise.resolve() };
    },
    async finish(requestId) {
      calls.push(["finish", requestId]);
      return { requestId, files: [] };
    },
    ...overrides,
  };
  return { service, calls };
}

function chat(workspaceChanges, sender = async () => {}) {
  return createChatService(
    { getSession: async () => session() },
    async () => sender,
    undefined,
    undefined,
    async () => {},
    workspaceChanges,
  );
}

test("开启代码工作视图时开始记录、返回编号并在请求结束后收尾", async () => {
  const { service, calls } = recorder();
  const result = await chat(service).send("你好", () => {}, () => {}, () => {}, undefined, () => {}, () => {}, {
    workspaceChanges: true,
  });

  assert.equal(result.changesRequestId, "wc-1");
  assert.deepEqual(calls, [["begin", "s1", "/work"], ["finish", "wc-1"]]);
});

test("关闭代码工作视图时不创建记录", async () => {
  const { service, calls } = recorder();
  const result = await chat(service).send("你好", () => {}, () => {}, () => {}, undefined, () => {}, () => {}, {
    workspaceChanges: false,
  });

  assert.equal("changesRequestId" in result, false);
  assert.deepEqual(calls, []);
});

test("记录开始失败时仍允许发送，只是没有改动卡片", async () => {
  const { service } = recorder({
    async begin() {
      throw new Error("临时目录不可写");
    },
  });
  const result = await chat(service).send("你好", () => {}, () => {}, () => {}, undefined, () => {}, () => {}, {
    workspaceChanges: true,
  });

  assert.equal(result.stopped, false);
  assert.equal("changesRequestId" in result, false);
});

test("生成异常时仍结束本轮记录，避免临时文件滞留", async () => {
  const { service, calls } = recorder();
  const failing = async () => { throw new Error("模型失败"); };
  const serviceWithChat = chat(service, failing);

  await assert.rejects(
    serviceWithChat.send("你好", () => {}, () => {}, () => {}, undefined, () => {}, () => {}, {
      workspaceChanges: true,
    }),
    /模型失败/,
  );
  assert.deepEqual(calls, [["begin", "s1", "/work"], ["finish", "wc-1"]]);
});
