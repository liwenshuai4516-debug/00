const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(save) {
  const { createComposerDraftQueue } = await import(
    "../../src/renderer/components/composer-draft-queue.js"
  );
  const calls = [];
  const queue = createComposerDraftQueue(async (id, text, revision) => {
    calls.push([id, text, revision]);
    if (save) return save(id, text, revision);
    return { sessionId: id, text, revision: revision + 1 };
  });
  queue.register({ sessionId: "a", text: "", revision: 0 });
  return { queue, calls };
}

test("保存原文和主动清空，未变化时不重复写入", async () => {
  const { queue, calls } = await setup();
  await queue.flush("a");
  assert.deepEqual(calls, []);

  const text = " \t中文  \r\n\n末尾 ";
  queue.setText("a", text);
  assert.deepEqual(await queue.flush("a"), {
    sessionId: "a", text, revision: 1,
  });

  queue.setText("a", "");
  await queue.flush("a");
  await queue.flush("a");
  assert.deepEqual(calls, [["a", text, 0], ["a", "", 1]]);
});

test("同一会话只保存一份在途内容，后续编辑合并为最新正文", async () => {
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const { queue, calls } = await setup(async (id, text, revision) => {
    if (revision === 0) {
      entered.resolve();
      await finished.promise;
    }
    return { sessionId: id, text, revision: revision + 1 };
  });

  queue.setText("a", "第一版");
  const pending = queue.flush("a");
  try {
    await entered.promise;
    queue.setText("a", "第二版");
    assert.equal(queue.flush("a"), pending);
    queue.setText("a", "第三版");
    assert.deepEqual(calls, [["a", "第一版", 0]]);
  } finally {
    finished.resolve();
    await pending;
  }
  assert.deepEqual(calls, [["a", "第一版", 0], ["a", "第三版", 1]]);
});

test("在途保存期间改回空输入，确认后仍补写清空", async () => {
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const { queue, calls } = await setup(async (id, text, revision) => {
    if (revision === 0) {
      entered.resolve();
      await finished.promise;
    }
    return { sessionId: id, text, revision: revision + 1 };
  });

  queue.setText("a", "即将清空");
  const pending = queue.flush("a");
  try {
    await entered.promise;
    queue.setText("a", "");
  } finally {
    finished.resolve();
    await pending;
  }
  assert.deepEqual(calls, [["a", "即将清空", 0], ["a", "", 1]]);
});

test("A 的慢保存不阻塞 B，响应不会改变另一会话", async () => {
  const entered = Promise.withResolvers();
  const finished = Promise.withResolvers();
  const { queue, calls } = await setup(async (id, text, revision) => {
    if (id === "a") {
      entered.resolve();
      await finished.promise;
    }
    return { sessionId: id, text, revision: revision + 1 };
  });

  queue.register({ sessionId: "b", text: "B 原文", revision: 4 });
  queue.setText("a", "A 新输入");
  const pending = queue.flush("a");
  try {
    await entered.promise;
    queue.setText("b", "B 新输入");
    assert.deepEqual(await queue.flush("b"), {
      sessionId: "b", text: "B 新输入", revision: 5,
    });
  } finally {
    finished.resolve();
    await pending;
  }
  assert.deepEqual(calls, [["a", "A 新输入", 0], ["b", "B 新输入", 4]]);
});

test("失败保留编辑与版本，迟到读取不覆盖，显式重试保存最新原文", async () => {
  const failure = new Error("模拟写入失败");
  let fail = true;
  const { queue, calls } = await setup((id, text, revision) => {
    if (fail) throw failure;
    return { sessionId: id, text, revision: revision + 1 };
  });

  queue.setText("a", "第一版");
  await assert.rejects(queue.flush("a"), (error) => error === failure);
  queue.setText("a", "失败后继续编辑");

  assert.deepEqual(queue.register({
    sessionId: "a", text: "旧读取", revision: 0,
  }), {
    sessionId: "a", text: "失败后继续编辑", revision: 0,
  });
  assert.equal(calls.length, 1);

  fail = false;
  await queue.flush("a");
  assert.deepEqual(calls, [
    ["a", "第一版", 0],
    ["a", "失败后继续编辑", 0],
  ]);
  assert.deepEqual(queue.register({
    sessionId: "a", text: "更迟的读取", revision: 0,
  }), {
    sessionId: "a", text: "失败后继续编辑", revision: 1,
  });
});

test("版本冲突向外报告，不采用新版本自动覆盖", async () => {
  const conflict = new Error("输入草稿版本已变化");
  const { queue, calls } = await setup(() => { throw conflict; });

  queue.setText("a", "本地输入");
  await assert.rejects(queue.flush("a"), (error) => error === conflict);
  assert.deepEqual(queue.register({
    sessionId: "a", text: "外部输入", revision: 8,
  }), {
    sessionId: "a", text: "本地输入", revision: 0,
  });
  assert.deepEqual(calls, [["a", "本地输入", 0]]);
});

test("未登记会话与不匹配的保存确认明确报错", async () => {
  const { queue, calls } = await setup(() => ({
    sessionId: "b", text: "错误归属", revision: 1,
  }));

  assert.throws(() => queue.setText("unknown", "输入"), /先读取并登记/);
  assert.throws(() => queue.flush("unknown"), /先读取并登记/);

  queue.setText("a", "保留原文");
  await assert.rejects(queue.flush("a"), /保存确认与提交内容不匹配/);
  assert.deepEqual(queue.register({
    sessionId: "a", text: "", revision: 0,
  }), {
    sessionId: "a", text: "保留原文", revision: 0,
  });
  assert.equal(calls.length, 1);
});