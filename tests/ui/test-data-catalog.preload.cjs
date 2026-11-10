const { contextBridge } = require("electron");

const cases = Array.from({ length: 52 }, (_, index) => ({
  caseId: index === 0 ? "contracts" : index === 1 ? "candidate" : `case-${index}`,
  title: index === 0 ? "合同列表按编号筛选并查看详情" : index === 1 ? "仅候选 · 权限边界" : `列表用例 ${index}`,
  modulePath: index >= 50 ? ["系统管理", "权限"] : ["合同管理", "经营合同"],
  role: "管理员",
  currentRevision: index === 1 ? null : "0001",
  displayRevision: "0001",
  candidates: index === 0 ? ["0002"] : index === 1 ? ["0001"] : [],
  assetHash: `hash-${index}`,
  runnable: index !== 1,
  manual: false,
  origin: "generated",
  priority: index === 0 ? "P1" : index === 1 ? "P2" : null,
  description: index === 0 ? "验证合同编号筛选、详情打开与结果一致性。" : "",
  updatedAt: Date.UTC(2026, 10, 9, 6, 0) - index * 60000,
  lastResult: index === 0 ? { status: "passed", finishedAt: "2026-11-09T06:00:00Z", runId: "run-regression" } : null,
}));

let manualSerial = 0;
const manuals = new Map();
function addManual(input) {
  manualSerial += 1;
  const caseId = `manual-${manualSerial}`;
  const folder = String(input.folder ?? "").split("/").map((part) => part.trim()).filter(Boolean);
  const item = {
    caseId,
    title: input.title,
    modulePath: folder.length > 0 ? folder : ["未分类"],
    folderPath: folder,
    role: input.role || "未指定角色",
    currentRevision: null,
    displayRevision: "0001",
    revisions: ["0001"],
    candidates: [],
    assetHash: `hash-${caseId}-1`,
    runnable: false,
    manual: true,
    origin: "manual",
    priority: input.priority || "P2",
    description: input.description || "",
    expected: input.expected || "",
    steps: Array.isArray(input.steps) ? input.steps : [],
    updatedAt: Date.now(),
    lastResult: null,
  };
  cases.push(item);
  manuals.set(caseId, item);
  return item;
}

const stats = { details: 0, lists: [], deletions: [], moves: [], manualCreates: [], manualUpdates: [] };

function folderTree(items) {
  const root = { children: new Map(), count: 0, verified: 0, candidates: 0 };
  for (const item of items) {
    const modulePath = item.folderPath ?? item.modulePath;
    let node = root;
    for (let index = 0; index < modulePath.length; index += 1) {
      const name = modulePath[index];
      let child = node.children.get(name);
      if (!child) child = { name, path: modulePath.slice(0, index + 1), children: new Map(), count: 0, verified: 0, candidates: 0 };
      node.children.set(name, child);
      node = child;
      node.count += 1;
      if (item.runnable) node.verified += 1;
      if (item.candidates.length > 0) node.candidates += 1;
    }
  }
  const serialize = (node) => [...node.children.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .map((child) => ({ name: child.name, path: child.path, count: child.count, verified: child.verified,
      candidates: child.candidates, children: serialize(child) }));
  return serialize(root);
}

function manualMeta(item) {
  return {
    title: item.title,
    targetUrl: "https://demo.invalid/contracts",
    role: item.role,
    initialState: "手动创建，未记录初态",
    dataStrategy: "read-only",
    cleanup: "none",
    description: item.description,
    priority: item.priority,
    origin: "manual",
    steps: item.steps.map((text, index) => ({ stepId: `manual-${String(index + 1).padStart(2, "0")}`, text })),
    expected: item.expected ? [{ id: "E1", text: item.expected, source: { kind: "user", reference: "用例面板手动创建" } }] : [],
    assertions: item.expected ? [{ kind: "business", text: item.expected, expectedId: "E1" }] : [],
  };
}

contextBridge.exposeInMainWorld("agent", {
  listProjectEnvironments: async () => [
    { id: "a", name: "演示项目", workspaceDir: "/demo/a" },
    { id: "b", name: "空项目", workspaceDir: "/demo/b" },
  ],
  getSessionInfo: async () => ({ workspaceDir: "/demo/a" }),
  listTestData: async (projectId, { page = 1, query = "", folder = "", filter = "all", sort = "updated" } = {}) => {
    stats.lists.push({ projectId, page, query, folder, filter, sort });
    const available = projectId === "a";
    const all = available ? cases : [];
    let filtered = all;
    if (folder) filtered = filtered.filter((item) => {
      const path = (item.folderPath ?? item.modulePath).join("/");
      return path === folder || path.startsWith(`${folder}/`);
    });
    if (query) filtered = filtered.filter((item) => `${item.title} ${item.caseId} ${(item.folderPath ?? item.modulePath).join("/")} ${item.description}`.includes(query));
    const filterCounts = {
      all: filtered.length,
      verified: filtered.filter((item) => item.runnable).length,
      candidate: filtered.filter((item) => item.candidates.length > 0).length,
      manual: filtered.filter((item) => item.manual).length,
    };
    if (filter === "verified") filtered = filtered.filter((item) => item.runnable);
    else if (filter === "candidate") filtered = filtered.filter((item) => item.candidates.length > 0);
    else if (filter === "manual") filtered = filtered.filter((item) => item.manual);
    filtered = [...filtered].sort((left, right) => {
      if (sort === "title") return left.title.localeCompare(right.title, "zh-CN");
      if (sort === "folder") return (left.folderPath ?? left.modulePath).join("/").localeCompare((right.folderPath ?? right.modulePath).join("/"), "zh-CN");
      return (right.updatedAt ?? 0) - (left.updatedAt ?? 0);
    });
    const pages = Math.max(1, Math.ceil(filtered.length / 50));
    page = Math.min(page, pages);
    return { available: true, items: [], truncated: false,
      catalog: { total: filtered.length, allTotal: all.length, page, pages, pageSize: 50,
        folder: folder ? folder.split("/") : [], folders: folderTree(all),
        filter, sort, filterCounts,
        verified: filterCounts.verified,
        candidates: filterCounts.candidate,
        manual: filterCounts.manual,
        cases: filtered.slice((page - 1) * 50, page * 50) } };
  },
  getTestCase: async (_projectId, caseId, revision) => {
    stats.details++;
    if (revision === "0002") await new Promise((resolve) => setTimeout(resolve, 100));
    const item = cases.find((entry) => entry.caseId === caseId);
    if (item?.manual) {
      return { caseId, assetHash: item.assetHash, revision, currentRevision: null, origin: "manual", manual: true,
        folder: item.folderPath, revisions: item.revisions.map((number) => ({ revision: number, taskId: "manual-task", origin: "manual" })),
        meta: manualMeta(item) };
    }
    return { caseId, assetHash: item.assetHash, revision, currentRevision: item.currentRevision,
      revisions: [{ revision: "0001", taskId: "task-source", validatedRunId: item.currentRevision ? "run-validated" : null },
        ...(caseId === "contracts" ? [{ revision: "0002", taskId: "task-source", validationRunId: "run-candidate" }] : [])],
      meta: { title: item.title, targetUrl: "https://demo.invalid/contracts", role: "管理员", initialState: "合同列表，编号 Beta 可重新定位", dataStrategy: "read-only", cleanup: "none",
        steps: [{ stepId: "step-1", text: revision === "0002" ? "新候选步骤" : "打开合同列表" }, { stepId: "step-2", text: "按编号筛选并打开详情" }],
        expected: [{ id: "E1", text: "详情编号与所选合同一致", source: { kind: "rule", reference: "合同需求第 3 条" } }],
        assertions: [{ kind: "business", text: "详情编号为 Beta", expectedId: "E1" }, { kind: "guard", text: "当前身份为管理员" }],
      } };
  },
  moveTestCase: async (projectId, caseId, folder, assetHash) => {
    const item = cases.find((candidate) => candidate.caseId === caseId && candidate.assetHash === assetHash);
    if (!item) throw new Error("版本已变化，请刷新。");
    const parts = String(folder ?? "").split("/").map((part) => part.trim()).filter(Boolean);
    if (parts.some((part) => part === "." || part === "..")) throw new Error("用例目录参数无效。");
    item.folderPath = parts.length > 0 ? parts : null;
    stats.moves.push({ projectId, caseId, folder: parts.join("/"), assetHash });
    return { caseId, folder: parts, assetHash };
  },
  createManualTestCase: async (projectId, input) => {
    const item = addManual(input);
    stats.manualCreates.push({ projectId, input });
    return { caseId: item.caseId, revision: "0001", folder: item.folderPath, assetHash: item.assetHash };
  },
  updateManualTestCase: async (projectId, caseId, input, assetHash) => {
    const item = manuals.get(caseId);
    if (!item || item.assetHash !== assetHash) throw new Error("版本已变化，请刷新。");
    const folder = String(input.folder ?? "").split("/").map((part) => part.trim()).filter(Boolean);
    item.title = input.title;
    item.folderPath = folder;
    item.modulePath = folder.length > 0 ? folder : ["未分类"];
    item.role = input.role || "未指定角色";
    item.priority = input.priority || "P2";
    item.description = input.description || "";
    item.expected = input.expected || "";
    item.steps = Array.isArray(input.steps) ? input.steps : [];
    item.displayRevision = String(Number(item.displayRevision) + 1).padStart(4, "0");
    item.revisions.push(item.displayRevision);
    item.assetHash = `hash-${caseId}-${item.displayRevision}`;
    item.updatedAt = Date.now();
    stats.manualUpdates.push({ projectId, caseId, input, assetHash });
    return { caseId, revision: item.displayRevision, folder, assetHash: item.assetHash };
  },
  deleteTestCase: async (projectId, caseId, assetHash) => {
    const index = cases.findIndex((item) => item.caseId === caseId && item.assetHash === assetHash);
    if (index < 0) throw new Error("版本已变化，请刷新。");
    stats.deletions.push({ projectId, caseId, assetHash });
    cases.splice(index, 1);
    manuals.delete(caseId);
    return { caseId };
  },
  getTestStats: async () => stats,
});
