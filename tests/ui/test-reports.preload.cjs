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
    testsTruncated: false,
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
    testCount: 2,
    counts: { passed: 1, failed: 1 },
    cleanup: "deleted",
    tracePolicy: "disabled-for-private-auth",
    problemsCount: 1,
    testsTruncated: false,
    summaryPath: "qa/ui/runs/ui-run/summary.json",
    modifiedAt: 1762200000000,
  },
];

const details = {
  "api:api-run": {
    ...reports[0],
    tests: [
      { title: "接口 A 通过", file: "api.spec.cjs", line: 3, status: "passed", durationMs: 20, error: "", attachments: [] },
      { title: "接口 B 通过", file: "api.spec.cjs", line: 9, status: "passed", durationMs: 30, error: "", attachments: [] },
    ],
    problems: [],
    versions: { node: "22.19.0", playwright: "1.64.1", files: 2 },
    limits: "接口测试临时夹具。",
  },
  "ui:ui-run": {
    ...reports[1],
    tests: [
      { title: "T1 登录成功", file: "ui.spec.cjs", line: 5, status: "passed", durationMs: 120, error: "", attachments: [] },
      {
        title: "T2 合同列表加载",
        file: "ui.spec.cjs",
        line: 12,
        status: "failed",
        durationMs: 90,
        error: "expect(received).toBe(expected)",
        attachments: [{ name: "failure.png", contentType: "image/png" }],
      },
    ],
    problems: ["附件缺失：failure.png"],
    versions: { node: "22.19.0", playwright: "1.64.1", files: 3 },
    limits: "仅展示临时夹具结果。",
  },
};

contextBridge.exposeInMainWorld("agent", {
  listProjectEnvironments: async () => [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
  ],
  getSessionInfo: async () => ({ workspaceDir: "/demo/a" }),
  listTestData: async () => ({
    available: true,
    truncated: false,
    items: [],
    catalog: {
      modules: [],
      legacy: [],
      truncated: false,
      totals: { modules: 0, submodules: 0, cases: 0, assertions: 0, legacy: 0 },
      lastRun: null,
    },
  }),
  listTestReports: async () => ({
    available: true,
    reports,
    truncated: false,
    invalid: 1,
    totals: { total: 2, ui: 1, api: 1, passed: 1, failed: 1, incomplete: 0, cancelled: 0 },
  }),
  getTestReport: async (_projectId, kind, id) => {
    const detail = details[`${kind}:${id}`];
    if (!detail) throw new Error("测试报告不存在或已被清理。");
    return detail;
  },
});
