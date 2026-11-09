const { contextBridge } = require("electron");
const cases = Array.from({ length: 52 }, (_, index) => ({
  caseId: index === 0 ? "contracts" : index === 1 ? "candidate" : `case-${index}`,
  title: index === 0 ? "合同列表按编号筛选并查看详情" : index === 1 ? "仅候选 · 权限边界" : `列表用例 ${index}`,
  modulePath: ["合同管理", "经营合同"], role: "管理员",
  currentRevision: index === 1 ? null : "0001", displayRevision: "0001",
  candidates: index === 0 ? ["0002"] : index === 1 ? ["0001"] : [],
  assetHash: `hash-${index}`, runnable: index !== 1,
  lastResult: index === 0 ? { status: "passed", finishedAt: "2026-11-09T06:00:00Z", runId: "run-regression" } : null,
}));
const files = [{ path: "api/sample.json", size: 1024 }];
const stats = { details: 0, lists: [], deletions: [] };
contextBridge.exposeInMainWorld("agent", {
  listProjectEnvironments: async () => [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
    { id: "b", name: "空项目", workspaceDir: "/demo/b" },
  ],
  getSessionInfo: async () => ({ workspaceDir: "/demo/a" }),
  listTestData: async (projectId, { page = 1, query = "" } = {}) => {
    stats.lists.push({ projectId, page, query });
    const filtered = projectId === "a" ? cases.filter((item) => `${item.title} ${item.caseId}`.includes(query)) : [];
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    page = Math.min(page, pages);
    return { available: true, items: projectId === "a" ? files : [], truncated: false,
      catalog: { total: filtered.length, page, pages, pageSize: 50, cases: filtered.slice((page - 1) * 50, page * 50) } };
  },
  getTestCase: async (_projectId, caseId, revision) => {
    stats.details++;
    if (revision === "0002") await new Promise((resolve) => setTimeout(resolve, 100));
    const item = cases.find((item) => item.caseId === caseId);
    return { caseId, assetHash: item.assetHash, revision, currentRevision: item.currentRevision,
      revisions: [{ revision: "0001", taskId: "task-source", validatedRunId: item.currentRevision ? "run-validated" : null },
        ...(caseId === "contracts" ? [{ revision: "0002", taskId: "task-source", validationRunId: "run-candidate" }] : [])],
      meta: { title: item.title, targetUrl: "https://demo.invalid/contracts", role: "管理员", initialState: "合同列表，编号 Beta 可重新定位", dataStrategy: "read-only", cleanup: "none",
        steps: [{ stepId: "step-1", text: revision === "0002" ? "新候选步骤" : "打开合同列表" }, { stepId: "step-2", text: "按编号筛选并打开详情" }],
        expected: [{ id: "E1", text: "详情编号与所选合同一致", source: { kind: "rule", reference: "合同需求第 3 条" } }],
        assertions: [{ kind: "business", text: "详情编号为 Beta", expectedId: "E1" }, { kind: "guard", text: "当前身份为管理员" }],
      } };
  },
  deleteTestCase: async (projectId, caseId, assetHash) => {
    const index = cases.findIndex((item) => item.caseId === caseId && item.assetHash === assetHash);
    if (index < 0) throw new Error("版本已变化，请刷新。");
    stats.deletions.push({ projectId, caseId, assetHash });
    cases.splice(index, 1);
    return { caseId };
  },
  deleteTestData: async (_projectId, relativePath) => {
    const index = files.findIndex((item) => item.path === relativePath);
    files.splice(index, 1);
    return { path: relativePath };
  },
  getTestStats: async () => stats,
});
