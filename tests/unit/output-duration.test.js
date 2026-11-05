const { test } = require("node:test");
const assert = require("node:assert/strict");

test("用时按秒、分钟、小时、天整合", async () => {
  const { formatDuration } = await import("../../src/renderer/components/output-trace.js");
  assert.equal(formatDuration(42), "42 ms");
  assert.equal(formatDuration(999), "999 ms");
  assert.equal(formatDuration(1000), "1.0 秒");
  assert.equal(formatDuration(7900), "7.9 秒");
  assert.equal(formatDuration(59000), "59 秒");
  assert.equal(formatDuration(59999), "1 分");
  assert.equal(formatDuration(60000), "1 分");
  assert.equal(formatDuration(65000), "1 分 5 秒");
  assert.equal(formatDuration(1075100), "17 分 55 秒");
  assert.equal(formatDuration(3600000), "1 小时");
  assert.equal(formatDuration(3660000), "1 小时 1 分");
  assert.equal(formatDuration(86400000), "1 天");
  assert.equal(formatDuration(90000000), "1 天 1 小时");
});

test("接近整分钟或整小时不出现 60 秒/60 分", async () => {
  const { formatDuration } = await import("../../src/renderer/components/output-trace.js");
  assert.equal(formatDuration(3599900), "1 小时");
  assert.equal(formatDuration(86399999), "1 天");
});
