const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  registerAgentIpc,
} = require("../../src/main/ipc/agent-ipc.js");

test("会话操作在生成期间被拒绝，空闲后正确转发", async () => {
  const handlers = new Map();
  const calls = [];
  let busy = true;

  // 只记录通信处理函数，不依赖真实 Electron。
  const ipcMain = {
    handle(channel, handler) {
      handlers.set(channel, handler);
    },
  };

  const sessionService = {
    openSession(id) {
      calls.push(["open", id]);
    },
    newChat() {
      calls.push(["new"]);
    },
    renameSession(name) {
      calls.push(["rename", name]);
    },
  };

  const chatService = {
    isBusy: () => busy,
  };

  registerAgentIpc(ipcMain, sessionService, chatService);

  const operations = [
    ["agent:open-session", "session-1"],
    ["agent:new-chat", undefined],
    ["agent:rename-session", "工作计划"],
  ];

  // 忙碌时不能进入会话操作。
  for (const [channel, value] of operations) {
    assert.throws(
      () => handlers.get(channel)({}, value),
      /请等待当前回复结束/,
    );
  }

  assert.deepEqual(calls, []);

  // 空闲时应向会话服务传递正确参数。
  busy = false;

  for (const [channel, value] of operations) {
    await handlers.get(channel)({}, value);
  }

  assert.deepEqual(calls, [
    ["open", "session-1"],
    ["new"],
    ["rename", "工作计划"],
  ]);
});


test("查看草稿时检查生成状态，并交给审阅服务校验", async () => {
  const handlers = new Map();
  const ids = [];
  let busy = true;

  registerAgentIpc(
    {
      handle(channel, handler) {
        handlers.set(channel, handler);
      },
    },
    {},
    {
      isBusy: () => busy,
    },
    {
      async review(id) {
        ids.push(id);
        return { id, path: "example.js" };
      },
    },
  );

  const handler = handlers.get("agent:get-proposal");

  // 生成期间不进入审阅服务。
  assert.throws(
    () => handler({}, "proposal-1"),
    /请等待当前回复结束/,
  );
  assert.deepEqual(ids, []);

  busy = false;

  assert.deepEqual(await handler({}, "proposal-1"), {
    id: "proposal-1",
    path: "example.js",
  });
  assert.deepEqual(ids, ["proposal-1"]);
});

test("生成时拒绝保存，空闲后只向保存服务转发编号", async () => {
  const handlers = new Map();
  const ids = [];
  let busy = true;

  registerAgentIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    {},
    { isBusy: () => busy },
    {},
    {
      async apply(id) {
        ids.push(id);
        return { id, path: "example.js", written: true };
      },
    },
  );

  const handler = handlers.get("agent:apply-proposal");
  assert.throws(() => handler({}, "p-1"), /请等待当前回复结束/);
  assert.deepEqual(ids, []);

  busy = false;
  assert.deepEqual(await handler({}, "p-1"), {
    id: "p-1", path: "example.js", written: true,
  });
  assert.deepEqual(ids, ["p-1"]);
});

test("保存期间阻止冲突操作，保存失败后释放状态", async () => {
  const handlers = new Map();
  const started = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const calls = [];
  let saves = 0;

  registerAgentIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    {
      openSession: () => calls.push("open"),
      newChat: () => calls.push("new"),
      renameSession: () => calls.push("rename"),
    },
    { isBusy: () => false, send: () => calls.push("send") },
    { review: () => calls.push("review") },
    {
      apply(id) {
        saves += 1;
        if (saves === 1) {
          started.resolve();
          return finished.promise;
        }
        return { id, path: "example.js", written: true };
      },
    },
  );

  const save = handlers.get("agent:apply-proposal");
  const pending = save({}, "p-1");
  await started.promise;

  for (const name of [
    "agent:apply-proposal",
    "agent:open-session",
    "agent:new-chat",
    "agent:rename-session",
    "agent:get-proposal",
    "agent:list-proposals",
  ]) {
    assert.throws(() => handlers.get(name)({}, "value"), /其他操作完成/);
  }
  assert.throws(
    () => handlers.get("agent:send-message")({}, "你好"),
    /当前操作结束/,
  );
  assert.equal(saves, 1);
  assert.deepEqual(calls, []);

  const rejected = assert.rejects(pending, /模拟保存失败/);
  finished.reject(new Error("模拟保存失败"));
  await rejected;

  assert.equal((await save({}, "p-1")).written, true);
  assert.equal(saves, 2);
});

test("新建会话期间拒绝保存，操作完成后允许保存", async () => {
  const handlers = new Map();
  const finished = Promise.withResolvers();
  let saves = 0;

  registerAgentIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    { newChat: () => finished.promise },
    { isBusy: () => false },
    {},
    { apply: () => { saves += 1; return { written: true }; } },
  );

  const pending = handlers.get("agent:new-chat")({});
  const save = handlers.get("agent:apply-proposal");
  assert.throws(() => save({}, "p-1"), /其他操作完成/);
  assert.equal(saves, 0);

  finished.resolve();
  await pending;
  await save({}, "p-1");
  assert.equal(saves, 1);
});


test("草稿列表在忙碌时拒绝读取，空闲后从当前会话服务取得", async () => {
  const handlers = new Map();
  let busy = true;
  let calls = 0;
  const expected = [{ id: "p-1", path: "example.js" }];

  registerAgentIpc(
    { handle: (name, handler) => handlers.set(name, handler) },
    {},
    {
      isBusy: () => busy,
      async listProposals() {
        calls += 1;
        return expected;
      },
    },
  );

  const handler = handlers.get("agent:list-proposals");
  assert.throws(() => handler({}), /请等待当前回复结束/);
  assert.equal(calls, 0);

  busy = false;
  assert.deepEqual(await handler({}), expected);
  assert.equal(calls, 1);
});

test("内置命令转发整理说明、资源命令与重新加载", async () => {
  const handlers = new Map();
  const calls = [];
  let busy = false;

  registerAgentIpc(
    { handle: (channel, handler) => handlers.set(channel, handler) },
    {
      compactSession(instructions) {
        calls.push(["compact", instructions]);
        return { history: [] };
      },
      listSlashCommands() {
        calls.push(["list"]);
        return { commands: [] };
      },
      reloadResources() {
        calls.push(["reload"]);
        return { diagnostics: [] };
      },
    },
    { isBusy: () => busy },
  );

  await handlers.get("agent:compact-session")({}, "保留结论");
  assert.deepEqual(await handlers.get("agent:list-slash-commands")({}), {
    commands: [],
  });
  await handlers.get("agent:reload-resources")({});

  assert.deepEqual(calls, [["compact", "保留结论"], ["list"], ["reload"]]);

  // 重新加载会改写会话资源，生成期间必须拒绝。
  busy = true;
  assert.throws(
    () => handlers.get("agent:reload-resources")({}),
    /请等待当前回复结束/,
  );
});

test("版本用例的分页和详情只读转发，整例删除共用空闲互斥，旧编辑通道退出", async () => {
  const handlers = new Map();
  const calls = [];
  let busy = true;
  const pending = Promise.withResolvers();
  registerAgentIpc({ handle: (key, value) => handlers.set(key, value) }, {}, { isBusy: () => busy }, null, null, null, null, {
    listTestData: (...args) => { calls.push(["list", ...args]); return "list"; },
    getTestCase: (...args) => { calls.push(["get", ...args]); return "detail"; },
    deleteTestCase: (...args) => { calls.push(["delete", ...args]); return pending.promise; },
  });
  const options = { page: 3, query: "列表" };
  assert.equal(handlers.get("agent:list-test-data")({}, "p1", options), "list");
  assert.equal(handlers.get("agent:get-test-case")({}, "p1", "case1", "0002"), "detail");
  assert.throws(() => handlers.get("agent:delete-test-case")({}, "p1", "case1", "hash"), /请等待/);
  busy = false;
  const deletion = handlers.get("agent:delete-test-case")({}, "p1", "case1", "hash");
  assert.throws(() => handlers.get("agent:delete-test-case")({}, "p1", "case1", "hash"), /请等待/);
  pending.resolve({ caseId: "case1" });
  assert.deepEqual(await deletion, { caseId: "case1" });
  assert.deepEqual(calls, [["list", "p1", options], ["get", "p1", "case1", "0002"], ["delete", "p1", "case1", "hash"]]);
  for (const channel of ["agent:update-test-case-assertions", "agent:update-test-case-steps", "agent:update-test-case-marks", "agent:delete-test-cases"]) assert.equal(handlers.has(channel), false);
});
