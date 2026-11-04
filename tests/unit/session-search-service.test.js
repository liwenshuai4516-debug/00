const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createSessionSearch } = require("../../src/main/services/session-search-service.js");

test("会话内容搜索返回片段并跳过读取失败的会话", async () => {
  const sessions = [
    { id: "s1", updatedAt: 3 },
    { id: "s2", updatedAt: 2 },
    { id: "s3", updatedAt: 1 },
  ];
  const histories = {
    s1: [{ role: "user", text: "前置文字 断言失败 后置文字" }],
    s2: null,
    s3: [{ role: "assistant", text: "这里也有断言" }],
  };
  const search = createSessionSearch({
    listSessions: async () => sessions,
    previewSession: async (id) => {
      if (histories[id] === null) throw new Error("读取失败");
      return { history: histories[id] };
    },
  });

  const result = await search("断言");
  assert.deepEqual(result.items.map((item) => item.id), ["s1", "s3"]);
  assert.match(result.items[0].snippet, /断言失败/);
  assert.equal(result.items[0].matches, 1);
  assert.equal(result.truncated, false);

  // 少于两个字符不扫描，避免一次输入触发大量读取。
  assert.deepEqual(await search("断"), { items: [], truncated: false });
});

test("会话内容搜索限制扫描范围与结果数，并对长文本加省略号", async () => {
  const longText = `${"甲".repeat(80)}唯一词${"乙".repeat(80)}`;
  const sessions = Array.from({ length: 5 }, (_, index) => ({ id: `s${index}`, updatedAt: 10 - index }));
  const search = createSessionSearch({
    listSessions: async () => sessions,
    previewSession: async (id) => ({
      history: [{ role: "user", text: id === "s0" ? longText : "唯一词" }],
    }),
    maxSessions: 2,
    maxItems: 1,
  });

  const result = await search("唯一词");
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].id, "s0");
  assert.ok(result.items[0].snippet.startsWith("…"));
  assert.ok(result.items[0].snippet.endsWith("…"));
  assert.equal(result.truncated, true);

  await assert.rejects(() => search("x".repeat(65)), /搜索词过长/);
});
