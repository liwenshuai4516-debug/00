const { contextBridge } = require("electron");

const reports = [
  {
    id: "api-run",
    runId: "api-run",
    kind: "api",
    moduleName: "采购合同",
    modulePath: ["合同管理", "采购合同"],
    status: "passed",
    startedAt: "2026-11-04T07:00:00.000Z",
    finishedAt: "2026-11-04T07:01:00.000Z",
    durationMs: 60000,
    targetUrl: "https://demo.invalid/api",
    project: { id: "a", name: "演示项目" },
    caseIds: ["api-login", "api-list"],
    testCount: 2,
    counts: { passed: 2 },
    cleanup: "not-needed",
    tracePolicy: "",
    problemsCount: 0,
    summaryPath: "qa/api/runs/api-run/summary.json",
    modifiedAt: 1762300000000,
  },
  {
    id: "ui-run",
    runId: "ui-run",
    kind: "ui",
    moduleName: "经营合同",
    modulePath: ["合同管理", "经营合同"],
    status: "failed",
    startedAt: "2026-11-04T06:00:00.000Z",
    finishedAt: "2026-11-04T06:01:00.000Z",
    durationMs: 60000,
    targetUrl: "https://demo.invalid/ui",
    project: { id: "a", name: "演示项目" },
    caseIds: ["case-a", "case-b"],
    workflow: "browser-use-playwright",
    purpose: "regression",
    testCount: 103,
    counts: { passed: 102, failed: 1 },
    cleanup: "deleted",
    tracePolicy: "disabled-for-private-auth",
    problemsCount: 1,
    summaryPath: "qa/ui/runs/ui-run/summary.json",
    modifiedAt: 1762200000000,
  },
];

const uiTests = Array.from({ length: 103 }, (_, index) => ({
  title: `T${index + 1} 合同列表加载`, file: "case-a/revisions/0002/case.spec.cjs", line: index + 1,
  status: index === 102 ? "failed" : "passed", durationMs: 90,
  error: index === 102 ? "expect(received).toBe(expected)" : "",
  attachments: index === 102 ? [{ name: "failure.png", contentType: "image/png" }] : [],
}));
for (let index = 0; index < 51; index += 1) {
  reports.push({ ...reports[1], id: `older-${index}`, runId: `older-${index}`, moduleName: `历史模块 ${index}`,
    status: "passed", testCount: 1, counts: { passed: 1 } });
}
const stats = { lists: [], details: [], heldList: false, heldDetail: false };
let holdList = false;
let holdDetail = false;
let releaseList;
let releaseDetail;
function paginate(items, requested = 1) {
  const pages = Math.max(1, Math.ceil(items.length / 50));
  const page = Math.min(requested, pages);
  return { items: items.slice((page - 1) * 50, page * 50), pagination: { page, pages, total: items.length, pageSize: 50 } };
}
function list(projectId, options = {}) {
  const all = projectId === "b" ? [{ ...reports[0], moduleName: "另一项目" }] : reports;
  const filtered = options.kind && options.kind !== "all" ? all.filter((item) => item.kind === options.kind) : all;
  const { items, pagination } = paginate(filtered, options.page);
  return { available: true, reports: items, pagination, invalid: 1,
    totals: { total: all.length, ui: all.filter((item) => item.kind === "ui").length,
      api: all.filter((item) => item.kind === "api").length, passed: all.filter((item) => item.status === "passed").length,
      failed: all.filter((item) => item.status === "failed").length, incomplete: 0, cancelled: 0 } };
}
contextBridge.exposeInMainWorld("__reportFixture", {
  stats: () => stats,
  holdList: () => { holdList = true; },
  releaseList: () => releaseList(),
  holdDetail: () => { holdDetail = true; },
  releaseDetail: () => releaseDetail(),
});
contextBridge.exposeInMainWorld("agent", {
  listProjectEnvironments: async () => [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
    { id: "b", name: "另一项目", workspaceDir: "/demo/b" },
  ],
  getSessionInfo: async () => ({ workspaceDir: "/demo/a" }),
  listTestData: async () => ({ available: true, items: [], catalog: { cases: [], total: 0, page: 1, pages: 1, pageSize: 50, invalid: 0 } }),
  listTestReports: async (projectId, options = {}) => {
    stats.lists.push({ projectId, ...options });
    const result = list(projectId, options);
    if (holdList) {
      holdList = false;
      stats.heldList = true;
      result.reports = result.reports.map((item) => ({ ...item, moduleName: "迟到列表" }));
      return new Promise((resolve) => { releaseList = () => { stats.heldList = false; resolve(result); }; });
    }
    return result;
  },
  getTestReport: async (projectId, kind, id, options = {}) => {
    stats.details.push({ projectId, kind, id, ...options });
    const report = reports.find((item) => item.kind === kind && item.id === id);
    if (!report) throw new Error("测试报告不存在或已被清理。");
    const allTests = kind === "ui" ? uiTests : [{ title: "接口 A 通过", file: "api.spec.cjs", line: 3, status: "passed", durationMs: 20, error: "", attachments: [] }];
    const { items, pagination } = paginate(allTests, options.page);
    const failures = allTests.filter((item) => item.status === "failed");
    const result = { ...report, tests: items, pagination, failures, failureCount: failures.length,
      selections: kind === "ui" ? [{ caseId: "case-a", revision: "0002", taskId: "task-source" }] : [],
      problems: ["附件缺失：failure.png"], versions: { node: "22.19.0", playwright: "1.64.1", files: 3 }, limits: "仅展示临时夹具结果。" };
    if (holdDetail) {
      holdDetail = false;
      stats.heldDetail = true;
      result.limits = "迟到详情";
      return new Promise((resolve) => { releaseDetail = () => { stats.heldDetail = false; resolve(result); }; });
    }
    return result;
  },
  deleteTestReport: async (_projectId, kind, id) => {
    const index = reports.findIndex((report) => report.kind === kind && report.id === id);
    if (index < 0) throw new Error("测试报告不存在或已被清理。");
    reports.splice(index, 1);
    return { kind, id };
  },
});
