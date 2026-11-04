const { contextBridge } = require("electron");

const catalog = {
  modules: [
    {
      key: "合同管理",
      path: ["合同管理"],
      title: "合同管理",
      depth: 0,
      page: "",
      role: "",
      dataPolicy: "",
      tags: [],
      policies: [],
      cases: [],
      children: [
        {
          key: "合同管理\u001f经营合同",
          path: ["合同管理", "经营合同"],
          title: "经营合同",
          depth: 1,
          page: "/pms/OperationContract",
          role: "管理员",
          dataPolicy: "read-only",
          pages: ["/pms/OperationContract"],
          roles: ["管理员"],
          tags: ["合同管理", "列表"],
          policies: ["read-only"],
          caseCount: 2,
          children: [],
          cases: [
            {
              name: "T2 权限拒绝时列表为空",
              type: "permission",
              priority: "P0",
              steps: ["打开合同列表", "以无权限账号访问", "确认列表为空"],
              assertions: [
                { id: "A1", kind: "business", text: "列表 0 行", source: "需求声明：无权限不可见" },
                { id: "A2", kind: "guard", text: "无权限提示可见", source: "页面基线" },
              ],
              caseId: "合同",
              assetPath: "ui/cases/合同.asset.json",
              specPath: "ui/cases/合同.spec.cjs",
              documentPath: "ui/cases/合同.md",
              page: "/pms/OperationContract",
              role: "管理员",
              recordedAt: "2026-11-04T06:48:43.222Z",
              lastResult: { status: "failed", durationMs: 12, finishedAt: "2026-11-04T06:51:00.000Z", runId: "run-1" },
            },
            {
              name: "T1 列表加载与结构完整",
              type: "functional",
              priority: "P2",
              steps: ["打开合同列表", "确认列表结构完整"],
              assertions: [
                { id: "A1", kind: "business", text: "列表出现", source: "页面基线" },
              ],
              caseId: "合同",
              assetPath: "ui/cases/合同.asset.json",
              specPath: "ui/cases/合同.spec.cjs",
              documentPath: "ui/cases/合同.md",
              page: "/pms/OperationContract",
              role: "管理员",
              recordedAt: "2026-11-04T06:48:43.222Z",
              lastResult: { status: "passed", durationMs: 8, finishedAt: "2026-11-04T06:51:00.000Z", runId: "run-1" },
            },
          ],
        },
        {
          key: "合同管理\u001f采购合同",
          path: ["合同管理", "采购合同"],
          title: "采购合同",
          depth: 1,
          page: "/pms/PurchaseContract",
          role: "管理员",
          dataPolicy: "read-only",
          pages: ["/pms/PurchaseContract"],
          roles: ["管理员"],
          tags: ["合同管理", "查询"],
          policies: ["read-only"],
          caseCount: 1,
          children: [],
          cases: [
            {
              name: "T3 合同编号不存在时展示空态",
              type: "exception",
              priority: "P2",
              steps: ["打开合同列表", "输入不存在的合同编号", "点击查询", "确认展示空态"],
              assertions: [
                { id: "A1", kind: "business", text: "共 0 条", source: "页面基线" },
                { id: "A2", kind: "business", text: "表格 0 行", source: "页面基线" },
              ],
              caseId: "合同查询",
              assetPath: "ui/cases/合同查询.asset.json",
              specPath: "ui/cases/合同查询.spec.cjs",
              documentPath: "ui/cases/合同查询.md",
              page: "/pms/PurchaseContract",
              role: "管理员",
              recordedAt: "2026-11-04T06:48:43.222Z",
              lastResult: { status: "passed", durationMs: 9, finishedAt: "2026-11-04T06:51:00.000Z", runId: "run-1" },
            },
          ],
        },
      ],
      caseCount: 3,
      assertionCount: 5,
    },
  ],
  legacy: [{ path: "ui/cases/旧资产.asset.json", name: "旧资产.asset.json", size: 64, modifiedAt: 1762300000000 }],
  truncated: false,
  totals: { modules: 1, submodules: 2, cases: 3, assertions: 5, legacy: 1 },
  lastRun: {
    runId: "run-1",
    status: "failed",
    startedAt: "2026-11-04T06:50:00.000Z",
    finishedAt: "2026-11-04T06:51:00.000Z",
    total: 3,
    passed: 2,
    failed: 1,
    skipped: 0,
    cancelled: 0,
  },
};

let currentCatalog = JSON.parse(JSON.stringify(catalog));
const items = [
  { path: "ui/cases/合同.asset.json", name: "合同.asset.json", category: "ui", size: 2048, modifiedAt: 1762300000000 },
  { path: "ui/cases/合同.spec.cjs", name: "合同.spec.cjs", category: "ui", size: 1024, modifiedAt: 1762300000000 },
  { path: "ui/cases/合同.md", name: "合同.md", category: "ui", size: 512, modifiedAt: 1762300000000 },
];

contextBridge.exposeInMainWorld("agent", {
  updateTestCaseSteps: async (_projectId, assetPath, caseName, steps) => {
    const findCase = (node) => {
      for (const item of node.cases ?? []) {
        if (item.assetPath === assetPath && item.name === caseName) return item;
      }
      for (const child of node.children ?? []) {
        const found = findCase(child);
        if (found) return found;
      }
      return null;
    };
    let item = null;
    for (const module of currentCatalog.modules) {
      item = findCase(module);
      if (item) break;
    }
    if (!item) throw new Error("未找到该用例");
    item.steps = steps;
    return { path: assetPath, caseName, steps };
  },
  updateTestCaseAssertions: async (_projectId, assetPath, caseName, assertions) => {
    const findCase = (node) => {
      for (const item of node.cases ?? []) {
        if (item.assetPath === assetPath && item.name === caseName) return item;
      }
      for (const child of node.children ?? []) {
        const found = findCase(child);
        if (found) return found;
      }
      return null;
    };
    let item = null;
    for (const module of currentCatalog.modules) {
      item = findCase(module);
      if (item) break;
    }
    if (!item) throw new Error("未找到该用例");
    item.assertions = assertions;
    const countAssertions = (node) => (node.cases ?? []).reduce((sum, test) => sum + test.assertions.length, 0)
      + (node.children ?? []).reduce((sum, child) => sum + countAssertions(child), 0);
    currentCatalog.totals.assertions = currentCatalog.modules.reduce((total, module) => total + countAssertions(module), 0);
    return { path: assetPath, caseName, assertions };
  },
  listProjectEnvironments: async () => [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
  ],
  getSessionInfo: async () => ({ workspaceDir: "/demo/a" }),
  listTestData: async () => ({ available: true, truncated: false, items, catalog: currentCatalog }),
  deleteTestData: async (_projectId, relativePath) => ({ path: relativePath }),
});
