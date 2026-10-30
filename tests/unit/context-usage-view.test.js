const { test } = require("node:test");
const assert = require("node:assert/strict");

async function format(usage) {
  const { formatContextUsage } = await import(
    "../../src/renderer/components/session-info-panel.js"
  );

  return formatContextUsage(usage);
}

test("缺少估算时明确显示暂不可用", async () => {
  assert.equal(
    await format(null),
    "上下文估算：暂不可用",
  );
});

test("压缩后未知值不显示为零", async () => {
  assert.equal(
    await format({
      tokens: null,
      contextWindow: 10000,
      percent: null,
    }),
    "上下文估算：等待模型回复后更新（窗口 10,000 tokens）",
  );
});

test("零值与正常估算均能显示", async () => {
  // 零是有效数据，与 null 表示的未知状态不同。
  assert.equal(
    await format({
      tokens: 0,
      contextWindow: 10000,
      percent: 0,
    }),
    "上下文估算：0 / 10,000 tokens（0.0%）",
  );

  assert.equal(
    await format({
      tokens: 1234,
      contextWindow: 10000,
      percent: 12.34,
    }),
    "上下文估算：1,234 / 10,000 tokens（12.3%）",
  );
});