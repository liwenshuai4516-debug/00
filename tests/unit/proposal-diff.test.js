const { test } = require("node:test");
const assert = require("node:assert/strict");
const { pathToFileURL } = require("node:url");
const path = require("node:path");

const modulePromise = import(pathToFileURL(path.join(
  __dirname, "../../src/renderer/components/proposal-diff.js",
)).href);

function verifyReconstruction(rows, before, after) {
  assert.equal(
    rows.filter((row) => row.kind !== "add").map((row) => row.text).join(""),
    before,
  );
  assert.equal(
    rows.filter((row) => row.kind !== "remove").map((row) => row.text).join(""),
    after,
  );
}

test("对齐相同行并标记修改，旧新行号分别递增", async () => {
  const { buildLineDiff } = await modulePromise;
  const before = "首行\n旧值\n末行\n";
  const after = "首行\n新值\n末行\n";
  const rows = buildLineDiff(before, after);

  assert.deepEqual(
    rows.map(({ kind, oldLine, newLine }) => [kind, oldLine, newLine]),
    [
      ["equal", 1, 1],
      ["remove", 2, null],
      ["add", null, 2],
      ["equal", 3, 3],
    ],
  );
  verifyReconstruction(rows, before, after);
});

test("插入、删除与空片段没有虚构占位行", async () => {
  const { buildLineDiff } = await modulePromise;
  assert.deepEqual(buildLineDiff("", ""), []);
  assert.deepEqual(buildLineDiff("", "\n"), [
    { kind: "add", oldLine: null, newLine: 1, text: "\n" },
  ]);

  const rows = buildLineDiff("删除\n", "");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].kind, "remove");
  verifyReconstruction(rows, "删除\n", "");
});

test("空格、Tab、连续空行和尾随空格不能被忽略", async () => {
  const { buildLineDiff } = await modulePromise;
  const before = "\t中文  \n\n\n  ";
  const after = "  中文\n\n\t\n ";
  const rows = buildLineDiff(before, after);

  verifyReconstruction(rows, before, after);
  assert.ok(rows.some(
    (row) => row.kind === "remove" && row.text === "\t中文  \n",
  ));
  assert.ok(rows.some(
    (row) => row.kind === "add" && row.text === "  中文\n",
  ));
});

test("CRLF、LF、CR及片段末尾换行差异都保留", async () => {
  const { buildLineDiff } = await modulePromise;
  for (const [before, after] of [
    ["a\r\nb\r", "a\nb\r"],
    ["a", "a\n"],
    ["\r\n\r\n", "\n\n"],
  ]) {
    const rows = buildLineDiff(before, after);
    verifyReconstruction(rows, before, after);
    assert.ok(rows.some((row) => row.kind === "remove"));
    assert.ok(rows.some((row) => row.kind === "add"));
  }
});

test("重复行与顺序变化仍按公共子序列对齐", async () => {
  const { buildLineDiff } = await modulePromise;
  const before = "A\nB\nA\nC\n";
  const after = "B\nA\nC\nD\n";
  const rows = buildLineDiff(before, after);

  verifyReconstruction(rows, before, after);
  assert.equal(rows.filter((row) => row.kind === "equal").length, 3);
  assert.equal(rows.filter((row) => row.kind === "remove").length, 1);
  assert.equal(rows.filter((row) => row.kind === "add").length, 1);
});

test("1000字符换行边界仍保留完整文本", async () => {
  const { buildLineDiff } = await modulePromise;
  const before = "\n".repeat(1000);
  const after = "\n".repeat(999) + "末";
  const rows = buildLineDiff(before, after);

  verifyReconstruction(rows, before, after);
  assert.equal(rows.filter((row) => row.kind === "equal").length, 999);
});
