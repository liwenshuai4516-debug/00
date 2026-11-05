// 回放结果只读：按当前会话工作区校验 qa/{ui,api}/runs/**/summary.json，返回逐测试统计。
const { readFile, realpath, stat } = require("node:fs/promises");
const path = require("node:path");

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TESTS = 200;
const MAX_TEXT = 500;
const SUMMARY_STATUSES = new Set(["passed", "failed", "incomplete", "cancelled", "unknown"]);
const TEST_STATUSES = new Set(["passed", "failed", "skipped", "flaky", "timedOut", "interrupted", "cancelled", "not-run", "unknown"]);

function text(value, limit) {
  return typeof value === "string" ? value.trim().slice(0, limit) : "";
}

function integer(value, limit) {
  const number = Number(value);
  return Number.isInteger(number) && number >= 0 && number <= limit ? number : undefined;
}

function normalizeTest(value) {
  if (!value || typeof value !== "object") return null;
  const errors = Array.isArray(value.errors) ? value.errors : [];
  const error = errors
    .map((item) => (typeof item === "string" ? item : item?.message ?? item?.value))
    .find((item) => typeof item === "string" && item.trim() !== "");
  return {
    title: text(value.title, 300) || "未命名用例",
    status: TEST_STATUSES.has(value.status) ? value.status : "unknown",
    durationMs: integer(value.durationMs, 86400000),
    error: text(error, MAX_TEXT),
  };
}

function normalizeSummary(summary) {
  if (!summary || typeof summary !== "object") throw new Error("回放摘要格式无效。");
  const tests = (Array.isArray(summary.tests) ? summary.tests : [])
    .map(normalizeTest)
    .filter(Boolean)
    .slice(0, MAX_TESTS);
  const counts = summary.counts && typeof summary.counts === "object" ? summary.counts : {};
  const passed = integer(counts.passed, 1000000) ?? tests.filter((test) => test.status === "passed").length;
  const failed = integer(counts.failed, 1000000) ?? tests.filter((test) => test.status === "failed").length;
  const skipped = integer(counts.skipped, 1000000) ?? tests.filter((test) => test.status === "skipped").length;
  const total = integer(counts.total, 1000000)
    ?? integer(summary.testCount, 1000000)
    ?? tests.length;
  const status = SUMMARY_STATUSES.has(summary.status)
    ? summary.status
    : failed > 0 ? "failed" : total > 0 && passed >= total ? "passed" : "unknown";
  const problems = (Array.isArray(summary.problems) ? summary.problems : [])
    .map((item) => text(item, MAX_TEXT))
    .filter(Boolean)
    .slice(0, 20);
  return {
    status,
    durationMs: integer(summary.durationMs, 86400000),
    counts: { total, passed, failed, skipped },
    tests,
    problems,
  };
}

function relativeParts(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return relative.split(path.sep);
}

function createReplayStatsReader(getWorkspaceDir) {
  return async function readReplayStats(input) {
    if (typeof input !== "string" || input.trim() === "" || input.length > 2048) {
      throw new Error("回放摘要路径无效。");
    }
    let workspace;
    try {
      workspace = await getWorkspaceDir();
    } catch {
      throw new Error("当前会话工作目录不可用。");
    }
    if (!workspace) throw new Error("当前会话还没有工作目录。");
    let root;
    try {
      root = await realpath(workspace);
    } catch {
      throw new Error("当前会话工作目录不可读。");
    }

    // 先解析真实路径，再校验归属：工作区或工具输出可能经过 /var 等符号链接。
    const candidate = path.resolve(root, input);
    let target;
    try {
      target = await realpath(candidate);
    } catch {
      throw new Error("回放摘要不存在或不可读。");
    }
    const targetParts = relativeParts(root, target);
    if (!targetParts || targetParts.length < 5 || targetParts[0] !== "qa" || !["ui", "api"].includes(targetParts[1]) || targetParts[2] !== "runs" || targetParts.at(-1) !== "summary.json") {
      throw new Error("回放摘要不在当前工作区的测试结果目录。");
    }

    let info;
    try {
      info = await stat(target);
    } catch {
      throw new Error("回放摘要不存在或不可读。");
    }
    if (!info.isFile()) throw new Error("回放摘要不是普通文件。");
    if (info.size > MAX_BYTES) throw new Error("回放摘要过大。");

    let summary;
    try {
      summary = JSON.parse(await readFile(target, "utf8"));
    } catch {
      throw new Error("回放摘要格式无效。");
    }
    return normalizeSummary(summary);
  };
}

module.exports = { createReplayStatsReader, normalizeSummary, MAX_TESTS };
