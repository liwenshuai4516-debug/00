const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createLineDiff } = require("../../src/main/services/line-diff.js");

function lcsCount(a, b) {
  const table = Array.from({ length: a.length + 1 }, () => new Uint16Array(b.length + 1));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j]
        ? table[i + 1][j + 1] + 1
        : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table[0][0];
}

test("相同内容不生成差异", () => {
  const result = createLineDiff("a\nb\nc\n", "a\nb\nc\n");
  assert.deepEqual(result, { hunks: [], added: 0, deleted: 0, coarse: false, truncated: false });
});

test("替换单行保留上下文与两侧行号", () => {
  const result = createLineDiff("a\nb\nc\n", "a\nB\nc\n");
  assert.equal(result.added, 1);
  assert.equal(result.deleted, 1);
  assert.equal(result.hunks.length, 1);
  const [hunk] = result.hunks;
  assert.deepEqual([hunk.oldStart, hunk.oldCount, hunk.newStart, hunk.newCount], [1, 3, 1, 3]);
  assert.deepEqual(hunk.rows.map((row) => [row.kind, row.oldLine, row.newLine, row.text]), [
    ["equal", 1, 1, "a"],
    ["remove", 2, null, "b"],
    ["add", null, 2, "B"],
    ["equal", 3, 3, "c"],
  ]);
});

test("新增与删除文件从空内容开始或结束", () => {
  const added = createLineDiff("", "x\ny\n");
  assert.equal(added.added, 2);
  assert.equal(added.deleted, 0);
  assert.deepEqual(added.hunks[0].rows.map((row) => row.newLine), [1, 2]);
  assert.equal(added.hunks[0].oldStart, 0);

  const removed = createLineDiff("x\ny\n", "");
  assert.equal(removed.added, 0);
  assert.equal(removed.deleted, 2);
  assert.equal(removed.hunks[0].newStart, 0);
});

test("相隔较远的改动拆成多个块，相近改动合并", () => {
  const before = Array.from({ length: 30 }, (_, index) => `line${index}`);
  const after = [...before];
  after[2] = "changed-2";
  after[20] = "changed-20";
  const spaced = createLineDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
  assert.equal(spaced.hunks.length, 2);
  assert.deepEqual(spaced.hunks.map((hunk) => hunk.oldStart), [1, 18]);

  const near = [...before];
  near[2] = "changed-2";
  near[4] = "changed-4";
  const merged = createLineDiff(`${before.join("\n")}\n`, `${near.join("\n")}\n`);
  assert.equal(merged.hunks.length, 1);
});

test("随机小样本的增删行数与最长公共子序列一致", () => {
  let seed = 7;
  const random = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let round = 0; round < 200; round += 1) {
    const before = Array.from({ length: 1 + Math.floor(random() * 12) }, () => String(Math.floor(random() * 4)));
    const after = Array.from({ length: 1 + Math.floor(random() * 12) }, () => String(Math.floor(random() * 4)));
    const result = createLineDiff(`${before.join("\n")}\n`, `${after.join("\n")}\n`);
    const common = lcsCount(before, after);
    assert.equal(result.added, after.length - common);
    assert.equal(result.deleted, before.length - common);
    for (const hunk of result.hunks) {
      for (const row of hunk.rows) {
        if (row.kind !== "add") assert.equal(before[row.oldLine - 1], row.text);
        if (row.kind !== "remove") assert.equal(after[row.newLine - 1], row.text);
      }
    }
  }
});

test("CRLF 与 LF 只按行内容比较", () => {
  const result = createLineDiff("a\r\nb\r\n", "a\nb\n");
  assert.deepEqual(result, { hunks: [], added: 0, deleted: 0, coarse: false, truncated: false });
});

test("超过行数上限时退化为整文件变化", () => {
  const before = Array.from({ length: 10 }, (_, index) => `a${index}`).join("\n");
  const after = Array.from({ length: 10 }, (_, index) => `b${index}`).join("\n");
  const result = createLineDiff(before, after, { maxLines: 5 });
  assert.equal(result.coarse, true);
  assert.equal(result.added, 10);
  assert.equal(result.deleted, 10);
  assert.deepEqual(result.hunks, []);
});

test("编辑距离超过上限时快速退化，不阻塞页面", () => {
  const before = Array.from({ length: 400 }, (_, index) => `a${index}`).join("\n");
  const after = Array.from({ length: 400 }, (_, index) => `b${index}`).join("\n");
  const result = createLineDiff(before, after, { maxEditDistance: 50, timeoutMs: 1000 });
  assert.equal(result.coarse, true);
  assert.equal(result.added, 400);
  assert.equal(result.deleted, 400);
});
