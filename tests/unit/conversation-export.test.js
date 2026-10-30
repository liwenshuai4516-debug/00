const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, readFile, rm } = require("node:fs/promises");
const {
  createConversationExportService,
} = require("../../src/main/services/conversation-export-service.js");
const {
  registerAgentIpc,
} = require("../../src/main/ipc/agent-ipc.js");

test("按用户选择的位置保存 UTF-8 展示文本，保留中文和换行", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-export-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const filePath = path.join(dir, "对话.txt");
  const sender = {};
  const history = [
    {
      role: "status",
      text: "上下文整理摘要\n已检查目录。",
    },
    {
      role: "user",
      text: "第一行\n  第二行",
    },
    {
      role: "assistant",
      text: "这是回复。",
    },
    {
      role: "tool",
      text: "读取完成",
      internalData: "不可导出的内部字段",
    },
  ];
  const before = JSON.stringify(history);

  const service = createConversationExportService(
    { loadHistory: async () => history },
    async (actualSender, options) => {
      assert.equal(actualSender, sender);
      assert.deepEqual(options.filters, [
        { name: "文本文件", extensions: ["txt"] },
      ]);

      return { canceled: false, filePath };
    },
  );

  assert.deepEqual(
    await service.exportConversation(sender),
    { canceled: false },
  );

  assert.equal(await readFile(filePath, "utf8"), [
    "当前对话（上下文快照）",
    "导出范围：当前上下文的展示文本，可能包含摘要或截断的工具结果。",
    "",
    "【状态】",
    "上下文整理摘要\n已检查目录。",
    "",
    "【我】",
    "第一行\n  第二行",
    "",
    "【Agent】",
    "这是回复。",
    "",
    "【工具】",
    "读取完成",
    "",
  ].join("\n"));

  assert.equal(JSON.stringify(history), before);
});

test("取消或没有选择目标文件时不写入", async () => {
  for (const selection of [
    { canceled: true, filePath: "/unused.txt" },
    { canceled: false },
  ]) {
    const service = createConversationExportService(
      { loadHistory: async () => [] },
      async () => selection,
      async () => assert.fail("取消导出不能写入文件"),
    );

    assert.deepEqual(
      await service.exportConversation({}),
      { canceled: true },
    );
  }
});

test("等待写入结束才报告成功，写入失败时透传错误", async () => {
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  let reportedSuccess = false;

  const service = createConversationExportService(
    { loadHistory: async () => [] },
    async () => ({
      canceled: false,
      filePath: "/unused.txt",
    }),
    () => {
      started.resolve();
      return finished.promise;
    },
  );

  const pending = service.exportConversation({}).then((result) => {
    reportedSuccess = true;
    return result;
  });

  await started.promise;
  assert.equal(reportedSuccess, false);

  // 先挂好拒绝断言，再模拟文件写入失败。
  const rejected = assert.rejects(pending, /模拟写入失败/);
  finished.reject(new Error("模拟写入失败"));

  await rejected;
  assert.equal(reportedSuccess, false);
});

test("生成时拒绝导出，选择位置期间拒绝冲突操作，取消后释放状态", async () => {
  const handlers = new Map();
  const choosing = Promise.withResolvers();
  const selected = Promise.withResolvers();
  const sender = {};

  let busy = true;
  let reads = 0;
  let newChats = 0;

  const service = createConversationExportService(
    {
      async loadHistory() {
        reads += 1;
        return [];
      },
    },
    (actualSender) => {
      assert.equal(actualSender, sender);
      choosing.resolve();
      return selected.promise;
    },
    async () => assert.fail("取消后不能写入"),
  );

  registerAgentIpc(
    {
      handle: (name, handler) => handlers.set(name, handler),
    },
    {
      newChat: () => {
        newChats += 1;
      },
    },
    { isBusy: () => busy },
    {},
    {},
    service,
  );

  const handler = handlers.get("agent:export-conversation");

  assert.throws(
    () => handler({ sender }),
    /请等待当前回复结束/,
  );
  assert.equal(reads, 0);

  busy = false;

  // 页面额外传来的路径或正文不能影响导出服务。
  const pending = handler(
    { sender },
    "/forged.txt",
    "伪造正文",
  );

  await choosing.promise;

  for (const channel of [
    "agent:export-conversation",
    "agent:new-chat",
    "agent:compact-session",
    "agent:apply-proposal",
  ]) {
    assert.throws(
      () => handlers.get(channel)({ sender }),
      /其他操作完成/,
    );
  }

  assert.throws(
    () => handlers.get("agent:send-message")({ sender }, "你好"),
    /当前操作结束/,
  );

  selected.resolve({ canceled: true });

  assert.deepEqual(await pending, { canceled: true });

  await handlers.get("agent:new-chat")({});
  assert.equal(newChats, 1);
});