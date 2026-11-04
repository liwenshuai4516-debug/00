const { contextBridge } = require("electron");

const catalog = {
  modules: [
    {
      key: "/pms/Contract",
      page: "/pms/Contract",
      title: "合同管理",
      role: "管理员",
      dataPolicy: "read-only",
      tags: ["合同管理", "列表"],
      cases: [
        {
          name: "T2 权限拒绝时列表为空",
          type: "permission",
          priority: "P0",
          assertions: [
            { id: "A1", kind: "business", text: "列表 0 行", source: "需求声明：无权限不可见" },
            { id: "A2", kind: "guard", text: "无权限提示可见", source: "页面基线" },
          ],
          caseId: "合同",
          assetPath: "ui/cases/合同.asset.json",
          specPath: "ui/cases/合同.spec.cjs",
          documentPath: "ui/cases/合同.md",
          recordedAt: "2026-11-04T06:48:43.222Z",
        },
        {
          name: "T1 列表加载与结构完整",
          type: "functional",
          priority: "P2",
          assertions: [
            { id: "A1", kind: "business", text: "列表出现", source: "页面基线" },
          ],
          caseId: "合同",
          assetPath: "ui/cases/合同.asset.json",
          specPath: "ui/cases/合同.spec.cjs",
          documentPath: "ui/cases/合同.md",
          recordedAt: "2026-11-04T06:48:43.222Z",
        },
      ],
    },
    {
      key: "/pms/Contract/Empty",
      page: "/pms/Contract/Empty",
      title: "合同查询",
      role: "管理员",
      dataPolicy: "read-only",
      tags: ["合同管理", "查询"],
      cases: [
        {
          name: "T3 合同编号不存在时展示空态",
          type: "exception",
          priority: "P2",
          assertions: [
            { id: "A1", kind: "business", text: "共 0 条", source: "页面基线" },
            { id: "A2", kind: "business", text: "表格 0 行", source: "页面基线" },
          ],
          caseId: "合同查询",
          assetPath: "ui/cases/合同查询.asset.json",
          specPath: "ui/cases/合同查询.spec.cjs",
          documentPath: "ui/cases/合同查询.md",
          recordedAt: "2026-11-04T06:48:43.222Z",
        },
      ],
    },
  ],
  legacy: [{ path: "ui/cases/旧资产.asset.json", name: "旧资产.asset.json", size: 64, modifiedAt: 1762300000000 }],
  truncated: false,
  totals: { modules: 2, cases: 3, assertions: 5, legacy: 1 },
};

const items = [
  { path: "ui/cases/合同.asset.json", name: "合同.asset.json", category: "ui", size: 2048, modifiedAt: 1762300000000 },
  { path: "ui/cases/合同.spec.cjs", name: "合同.spec.cjs", category: "ui", size: 1024, modifiedAt: 1762300000000 },
  { path: "ui/cases/合同.md", name: "合同.md", category: "ui", size: 512, modifiedAt: 1762300000000 },
];

contextBridge.exposeInMainWorld("agent", {
  listProjectEnvironments: async () => [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
  ],
  getSessionInfo: async () => ({ workspaceDir: "/demo/a" }),
  listTestData: async () => ({ available: true, truncated: false, items, catalog }),
  deleteTestData: async (_projectId, relativePath) => ({ path: relativePath }),
});
