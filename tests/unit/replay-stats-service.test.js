const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createReplayStatsReader } = require("../../src/main/services/replay-stats-service.js");

async function workspaceFixture(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "replay-stats-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const run = path.join(root, "qa", "ui", "runs", "run-1");
  await fs.mkdir(run, { recursive: true });
  const summaryFile = path.join(run, "summary.json");
  return { root, run, summaryFile };
}

test("读取当前工作区的回放摘要，只返回安全的逐测试统计", async (t) => {
  const { root, summaryFile } = await workspaceFixture(t);
  await fs.writeFile(summaryFile, JSON.stringify({
    status: "failed",
    durationMs: 1234,
    testCount: 2,
    counts: { total: 2, passed: 1, failed: 1 },
    problems: ["截图缺失"],
    tests: [
      { title: "创建合同", status: "passed", durationMs: 500 },
      { title: "审批合同", status: "failed", durationMs: 700, errors: [{ message: "断言失败：状态错误" }], file: "/secret/path.spec.js" },
    ],
  }));
  const read = createReplayStatsReader(async () => root);
  const result = await read(summaryFile);

  assert.deepEqual(result, {
    status: "failed",
    durationMs: 1234,
    counts: { total: 2, passed: 1, failed: 1, skipped: 0 },
    tests: [
      { title: "创建合同", status: "passed", durationMs: 500, error: "" },
      { title: "审批合同", status: "failed", durationMs: 700, error: "断言失败：状态错误" },
    ],
    problems: ["截图缺失"],
  });
  assert.equal(JSON.stringify(result).includes("/secret/path"), false);
});

test("拒绝工作区外、非 runs 目录和非 summary.json 的路径", async (t) => {
  const { root, run } = await workspaceFixture(t);
  const read = createReplayStatsReader(async () => root);
  const outside = path.join(os.tmpdir(), "outside-summary.json");
  await fs.writeFile(outside, "{}");
  t.after(() => fs.rm(outside, { force: true }));

  for (const value of [
    outside,
    path.join(root, "qa", "ui", "runs", "run-1", "other.json"),
    path.join(root, "qa", "ui", "other", "summary.json"),
    path.join(run, "..", "..", "..", "..", "..", "outside.json"),
    "",
    null,
  ]) {
    await assert.rejects(read(value), /回放摘要|路径无效/);
  }
});

test("符号链接指向工作区外时拒绝读取", async (t) => {
  const { root, run } = await workspaceFixture(t);
  const outside = path.join(os.tmpdir(), `replay-outside-${Date.now()}.json`);
  await fs.writeFile(outside, JSON.stringify({ status: "passed", tests: [] }));
  t.after(() => fs.rm(outside, { force: true }));
  const link = path.join(run, "summary.json");
  await fs.symlink(outside, link);
  const read = createReplayStatsReader(async () => root);
  await assert.rejects(read(link), /回放摘要/);
});

test("缺失、格式错误和超大摘要都返回明确错误", async (t) => {
  const { root, summaryFile } = await workspaceFixture(t);
  const read = createReplayStatsReader(async () => root);
  await assert.rejects(read(summaryFile), /不存在/);

  await fs.writeFile(summaryFile, "{ broken");
  await assert.rejects(read(summaryFile), /格式无效/);

  await fs.writeFile(summaryFile, JSON.stringify({ status: "passed", tests: [] }));
  const huge = path.join(path.dirname(summaryFile), "summary.json");
  await fs.writeFile(huge, "x".repeat(2 * 1024 * 1024 + 1));
  await assert.rejects(read(summaryFile), /过大/);
});
