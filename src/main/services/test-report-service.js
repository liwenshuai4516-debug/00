const path = require("node:path");
const { readdir, readFile, realpath, stat, lstat } = require("node:fs/promises");

// UI 与接口测试共用 qa-report/v1 摘要；目录按测试类型分开，页面统一聚合。
const REPORT_ROOTS = [
  { kind: "ui", segments: ["qa", "ui", "runs"] },
  { kind: "api", segments: ["qa", "api", "runs"] },
];
const MAX_REPORTS = 50;
const MAX_RUN_DIRECTORIES = 200;
const MAX_SUMMARY_BYTES = 2 * 1024 * 1024;
const MAX_TESTS = 100;
const MAX_PROBLEMS = 20;
const MAX_TEXT = 800;
const REPORT_STATUSES = new Set(["passed", "failed", "incomplete", "cancelled"]);
const REPORT_KINDS = new Set(["ui", "api"]);
const TEST_STATUSES = new Set([
  "passed",
  "failed",
  "timedOut",
  "skipped",
  "flaky",
  "expected-failure",
  "cancelled",
  "interrupted",
  "not-run",
  "unknown",
]);

function text(value, max = MAX_TEXT) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function integer(value, max) {
  return Number.isInteger(value) && value >= 0 && value <= max ? value : null;
}

function isOutside(relative) {
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function parseTime(value) {
  if (typeof value !== "string" || !value) return null;
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function normalizeProject(value) {
  if (value && typeof value === "object") {
    const id = text(value.id, 200);
    const name = text(value.name, 200);
    return id || name ? { id, name } : null;
  }
  const name = text(value, 200);
  return name ? { id: "", name } : null;
}

function normalizeCaseIds(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => text(item, 200))
    .filter(Boolean)
    .slice(0, 100);
}

function normalizeModulePath(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((segment) => text(segment, 60))
    .filter(Boolean)
    .slice(0, 6);
}

function moduleSummary(paths) {
  const unique = new Map();
  for (const modulePath of paths) {
    if (!modulePath.length) continue;
    unique.set(modulePath.join("\u001f"), modulePath);
  }
  if (unique.size === 0) return { name: "", path: [] };
  if (unique.size === 1) {
    const [modulePath] = unique.values();
    return { name: modulePath[modulePath.length - 1], path: modulePath };
  }
  const [first] = unique.values();
  return {
    name: `${first[first.length - 1]} 等 ${unique.size} 个模块`,
    path: [],
  };
}

async function readCaseModule(workspace, caseId) {
  if (!/^[\p{L}\p{N}_-]{1,180}$/u.test(caseId)) return [];
  const file = path.join(workspace, "qa", "data", "ui", "cases", `${caseId}.asset.json`);
  let info;
  try {
    info = await lstat(file);
  } catch {
    return [];
  }
  if (!info.isFile() || info.isSymbolicLink() || info.size > 512 * 1024) return [];
  try {
    const asset = JSON.parse(await readFile(file, "utf8"));
    return normalizeModulePath(asset?.caseMeta?.modulePath);
  } catch {
    return [];
  }
}

// 报告名称优先使用摘要声明的模块；旧批次回看 case 资产的 modulePath。
async function resolveModule(summary, workspace, cache) {
  const direct = normalizeModulePath(summary?.modulePath);
  if (direct.length > 0) return moduleSummary([direct]);
  const declared = text(summary?.module, 200);
  if (declared) return { name: declared, path: [] };
  const paths = [];
  for (const caseId of normalizeCaseIds(summary?.caseIds).slice(0, 5)) {
    let modulePath = cache.get(caseId);
    if (modulePath === undefined) {
      modulePath = await readCaseModule(workspace, caseId);
      cache.set(caseId, modulePath);
    }
    if (modulePath.length > 0) paths.push(modulePath);
  }
  return moduleSummary(paths);
}

function normalizeCounts(value, tests) {
  const counts = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, count] of Object.entries(value)) {
      const name = text(key, 40);
      const number = Number(count);
      if (name && Number.isInteger(number) && number >= 0) counts[name] = number;
    }
  }
  if (Object.keys(counts).length > 0) return counts;
  for (const test of tests) {
    const status = TEST_STATUSES.has(test?.status) ? test.status : "unknown";
    counts[status] = (counts[status] ?? 0) + 1;
  }
  return counts;
}

function deriveStatus(summary, tests) {
  if (REPORT_STATUSES.has(summary?.status)) return summary.status;
  if (tests.length === 0) return "incomplete";
  return tests.every((test) => test?.status === "passed") ? "passed" : "failed";
}

function normalizeReport(summary, kind, id, summaryPath, modifiedAt) {
  const tests = Array.isArray(summary?.tests) ? summary.tests : [];
  const startedAt = text(summary?.startedAt, 40);
  const finishedAt = text(summary?.finishedAt, 40);
  const startTime = parseTime(startedAt);
  const finishTime = parseTime(finishedAt);
  const durationMs = integer(summary?.durationMs, Number.MAX_SAFE_INTEGER)
    ?? (startTime !== null && finishTime !== null && finishTime >= startTime
      ? finishTime - startTime
      : null);
  const testCount = integer(summary?.testCount, 100000) ?? (Array.isArray(summary?.tests) ? tests.length : null);
  return {
    id,
    runId: text(summary?.runId, 200) || id,
    schema: text(summary?.schema, 40),
    kind: REPORT_KINDS.has(summary?.kind) ? summary.kind : kind,
    status: deriveStatus(summary, tests),
    startedAt,
    finishedAt,
    durationMs,
    targetUrl: text(summary?.targetUrl, 1000),
    project: normalizeProject(summary?.project),
    caseIds: normalizeCaseIds(summary?.caseIds),
    testCount,
    counts: normalizeCounts(summary?.counts, tests),
    cleanup: text(summary?.cleanup, 40),
    tracePolicy: text(summary?.tracePolicy, 80),
    problemsCount: Array.isArray(summary?.problems) ? summary.problems.length : 0,
    testsTruncated: tests.length > MAX_TESTS,
    summaryPath,
    modifiedAt,
  };
}

function normalizeTest(value) {
  const errors = Array.isArray(value?.errors) ? value.errors : [];
  const error = errors
    .map((item) => (typeof item === "string" ? item : item?.message ?? item?.value))
    .find((item) => typeof item === "string" && item.trim());
  const attachments = (Array.isArray(value?.attachments) ? value.attachments : [])
    .slice(0, 10)
    .map((attachment) => ({
      name: text(attachment?.name, 200),
      contentType: text(attachment?.contentType, 100),
    }))
    .filter((attachment) => attachment.name);
  return {
    title: text(value?.title, 500) || "未命名用例",
    file: text(value?.file, 300),
    line: integer(value?.line, 1000000),
    status: TEST_STATUSES.has(value?.status) ? value.status : "unknown",
    durationMs: integer(value?.durationMs, 86400000),
    error: text(error, 800),
    attachments,
  };
}

function normalizeProblems(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => text(item, MAX_TEXT)).filter(Boolean).slice(0, MAX_PROBLEMS);
}

function normalizeVersions(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return {
    node: text(value.node, 40),
    playwright: text(value.playwright, 40),
    files: Array.isArray(value.files) ? value.files.length : 0,
  };
}

function totalsOf(reports) {
  const totals = {
    total: reports.length,
    ui: 0,
    api: 0,
    passed: 0,
    failed: 0,
    incomplete: 0,
    cancelled: 0,
  };
  for (const report of reports) {
    if (report.kind === "ui") totals.ui += 1;
    if (report.kind === "api") totals.api += 1;
    if (Object.hasOwn(totals, report.status)) totals[report.status] += 1;
  }
  return totals;
}

// 报告只从项目工作区的固定运行目录读取，页面只提交项目编号与批次目录名。
function createTestReportService(projectStore) {
  async function resolveProject(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目环境。");
    }
    const project = (await projectStore.list()).find((item) => item.id === projectId);
    if (!project) throw new Error("未找到该项目环境，请重新读取。");
    return project;
  }

  async function resolveRoot(workspace, source) {
    const workspaceReal = await realpath(workspace);
    const root = path.join(workspaceReal, ...source.segments);
    let resolved;
    try {
      resolved = await realpath(root);
    } catch (error) {
      if (error.code === "ENOENT") return { workspaceReal, root: null };
      throw error;
    }
    const relative = path.relative(workspaceReal, resolved);
    if (!relative || isOutside(relative)) {
      throw new Error("测试报告目录超出项目工作区。");
    }
    const info = await stat(resolved);
    return { workspaceReal, root: info.isDirectory() ? resolved : null };
  }

  async function readSummary(file, workspaceReal) {
    let info;
    try {
      info = await lstat(file);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_SUMMARY_BYTES) return null;
    let summary;
    try {
      summary = JSON.parse(await readFile(file, "utf8"));
    } catch {
      return null;
    }
    if (!summary || typeof summary !== "object" || Array.isArray(summary)) return null;
    return {
      summary,
      modifiedAt: info.mtimeMs,
      relative: path.relative(workspaceReal, file).split(path.sep).join("/"),
    };
  }

  async function list(projectId) {
    const project = await resolveProject(projectId);
    const workspaceReal = await realpath(project.workspaceDir);
    const reports = [];
    const moduleCache = new Map();
    let invalid = 0;
    let available = false;
    let truncated = false;

    for (const source of REPORT_ROOTS) {
      const { root } = await resolveRoot(workspaceReal, source);
      if (!root) continue;
      available = true;
      let entries;
      try {
        entries = await readdir(root, { withFileTypes: true });
      } catch (error) {
        if (error.code === "ENOENT") continue;
        throw error;
      }
      const candidates = entries.filter(
        (entry) => entry.isDirectory() && !entry.name.startsWith("."),
      );
      if (candidates.length > MAX_RUN_DIRECTORIES) truncated = true;
      const directories = candidates.slice(0, MAX_RUN_DIRECTORIES);
      for (const entry of directories) {
        const file = path.join(root, entry.name, "summary.json");
        const parsed = await readSummary(file, workspaceReal);
        if (!parsed) {
          invalid += 1;
          continue;
        }
        const module = await resolveModule(parsed.summary, workspaceReal, moduleCache);
        reports.push({
          ...normalizeReport(
            parsed.summary,
            source.kind,
            entry.name,
            parsed.relative,
            parsed.modifiedAt,
          ),
          moduleName: module.name,
          modulePath: module.path,
        });
      }
    }

    reports.sort((first, second) => {
      const firstTime = parseTime(first.finishedAt) ?? first.modifiedAt ?? 0;
      const secondTime = parseTime(second.finishedAt) ?? second.modifiedAt ?? 0;
      return secondTime - firstTime;
    });
    const totals = totalsOf(reports);
    if (reports.length > MAX_REPORTS) {
      reports.length = MAX_REPORTS;
      truncated = true;
    }
    return { available, reports, truncated, invalid, totals };
  }

  async function get(projectId, kind, id) {
    if (!REPORT_KINDS.has(kind)) throw new Error("测试报告类型无效。");
    if (typeof id !== "string" || !/^[\p{L}\p{N}_.-]{1,200}$/u.test(id) || id === "." || id === "..") {
      throw new Error("测试报告编号无效。");
    }
    const project = await resolveProject(projectId);
    const source = REPORT_ROOTS.find((item) => item.kind === kind);
    const { workspaceReal, root } = await resolveRoot(project.workspaceDir, source);
    if (!root) throw new Error("测试报告不存在或已被清理。");
    let directoryInfo;
    try {
      directoryInfo = await lstat(path.join(root, id));
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("测试报告不存在或已被清理。");
      throw error;
    }
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) {
      throw new Error("测试报告目录无效。");
    }
    const parsed = await readSummary(path.join(root, id, "summary.json"), workspaceReal);
    if (!parsed) throw new Error("测试报告不存在、格式无效或超过大小限制。");
    const summary = parsed.summary;
    const tests = (Array.isArray(summary.tests) ? summary.tests : []).slice(0, MAX_TESTS);
    const module = await resolveModule(summary, workspaceReal, new Map());
    return {
      ...normalizeReport(summary, kind, id, parsed.relative, parsed.modifiedAt),
      moduleName: module.name,
      modulePath: module.path,
      tests: tests.map(normalizeTest),
      testsTruncated: Array.isArray(summary.tests) && summary.tests.length > MAX_TESTS,
      problems: normalizeProblems(summary.problems),
      versions: normalizeVersions(summary.versions),
      limits: text(summary.limits, 1000),
    };
  }

  return { list, get };
}

module.exports = { createTestReportService };
