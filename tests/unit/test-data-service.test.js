const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { createTestDataService } = require("../../src/main/services/test-data-service.js");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");

async function setup(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "test-data-versions-")));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const service = createTestDataService({ list: async () => [{ id: "p1", name: "演示项目", address: "https://demo.invalid", workspaceDir: workspace }] });
  async function save(caseId, { title = caseId, revision = "0001", formal = false, modulePath = ["合同", "列表"], projectId = "p1" } = {}) {
    const directory = path.join(workspace, "qa/ui/cases", caseId);
    const dest = path.join(directory, "revisions", revision);
    await fs.mkdir(dest, { recursive: true });
    const meta = { schema: "qa-ui-case/v1", caseId, title, modulePath, project: { id: projectId }, taskId: "task-1", targetUrl: "http://localhost/list", role: "管理员",
      initialState: "列表初态", dataStrategy: "read-only", cleanup: "none", expected: [{ id: "E1", text: "列表出现", source: { kind: "rule", reference: "需求" } }],
      steps: [{ stepId: "s1", text: "打开列表" }], assertions: [{ kind: "business", text: "列表出现", expectedId: "E1" }] };
    const bytes = JSON.stringify(meta);
    const script = "test('list', async () => {});";
    await fs.writeFile(path.join(dest, "case.json"), bytes);
    await fs.writeFile(path.join(dest, "case.spec.cjs"), script);
    let asset;
    try { asset = JSON.parse(await fs.readFile(path.join(directory, "asset.json"))); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    asset ??= { schema: "qa-ui-asset/v1", caseId, currentRevision: null, revisions: [] };
    asset.revisions.push({ revision, taskId: "task-1", validatedRunId: formal ? "run-validation" : null,
      hashes: { "case.json": hash(bytes), "case.spec.cjs": hash(script) } });
    if (formal) asset.currentRevision = revision;
    await fs.writeFile(path.join(directory, "asset.json"), JSON.stringify(asset));
    return { directory, dest, meta, asset };
  }
  async function run(runId, { revision = "0001", purpose = "regression", status = "passed", finishedAt = "2026-11-09T10:00:00Z", workflow = "browser-use-playwright" } = {}) {
    const directory = path.join(workspace, "qa/ui/runs", runId);
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(path.join(directory, "summary.json"), JSON.stringify({ schema: "qa-report/v1", workflow, runId, purpose, project: { id: "p1" }, workspace, status, finishedAt,
      revisions: { demo: revision }, tests: [{ file: `demo/revisions/${revision}/case.spec.cjs`, status }] }));
  }
  return { workspace, service, save, run };
}

test("先对全部用例排序筛选再分页，超过 200 条仍可访问末页；列表不内嵌详情、不写状态", async (t) => {
  const { service, save, workspace } = await setup(t);
  for (let i = 204; i >= 0; i--) await save(`case-${String(i).padStart(3, "0")}`);
  const first = await service.list("p1");
  assert.equal(first.catalog.total, 205);
  assert.equal(first.catalog.pages, 5);
  assert.equal(first.catalog.cases.length, 50);
  assert.equal(first.catalog.cases[0].caseId, "case-000");
  assert.equal(first.catalog.cases[0].meta, undefined);
  assert.equal(first.catalog.cases[0].revisions, undefined);
  const last = await service.list("p1", { page: 5 });
  assert.deepEqual(last.catalog.cases.map((item) => item.caseId), ["case-200", "case-201", "case-202", "case-203", "case-204"]);
  const filtered = await service.list("p1", { page: 2, query: "case-20" });
  assert.equal(filtered.catalog.total, 5);
  assert.equal(filtered.catalog.page, 1);
  assert.equal(filtered.catalog.cases[4].caseId, "case-204");
  assert.equal((await service.list("p1", { query: "管理员" })).catalog.total, 205);
  assert.equal((await service.list("p1", { query: "合同 / 列表" })).catalog.total, 205);
  assert.deepEqual((await fs.readdir(path.join(workspace, "qa/ui"))).sort(), ["cases"]);
});

test("用例目录按 modulePath 生成完整树、统计与筛选，分页基于筛选结果", async (t) => {
  const { service, save } = await setup(t);
  await save("contract-list", { modulePath: ["合同管理", "经营合同"] });
  await save("contract-detail", { modulePath: ["合同管理", "经营合同"] });
  await save("purchase", { modulePath: ["合同管理/采购合同"] });
  await save("permission", { formal: true, modulePath: ["系统管理", "权限"] });
  await save("uncategorized", { modulePath: [] });
  const all = await service.list("p1");
  assert.equal(all.catalog.allTotal, 5);
  assert.equal(all.catalog.total, 5);
  assert.equal(all.catalog.verified, 1);
  assert.equal(all.catalog.candidates, 4);
  const contract = all.catalog.folders.find((node) => node.name === "合同管理");
  assert.deepEqual(contract.path, ["合同管理"]);
  assert.equal(contract.count, 3);
  assert.equal(contract.children.find((node) => node.name === "经营合同").count, 2);
  assert.equal(contract.children.find((node) => node.name === "采购合同").count, 1);
  assert.equal(all.catalog.folders.find((node) => node.name === "系统管理").verified, 1);
  assert.equal(all.catalog.folders.find((node) => node.name === "未分类").count, 1);

  const nested = await service.list("p1", { folder: "合同管理/经营合同" });
  assert.deepEqual(nested.catalog.folder, ["合同管理", "经营合同"]);
  assert.equal(nested.catalog.total, 2);
  assert.equal(nested.catalog.allTotal, 5);
  assert.deepEqual(nested.catalog.cases.map((item) => item.caseId).sort(), ["contract-detail", "contract-list"]);
  const queried = await service.list("p1", { folder: "合同管理", query: "采购" });
  assert.equal(queried.catalog.total, 1);
  assert.equal(queried.catalog.cases[0].caseId, "purchase");
  assert.equal((await service.list("p1", { folder: "不存在" })).catalog.total, 0);
  for (const folder of ["../x", "合同管理//经营合同", "x".repeat(81), 123]) {
    await assert.rejects(service.list("p1", { folder }), /目录/);
  }

  const permission = all.catalog.cases.find((item) => item.caseId === "permission");
  const moved = await service.moveCase("p1", "permission", "合同管理/经营合同", permission.assetHash);
  assert.deepEqual(moved.folder, ["合同管理", "经营合同"]);
  assert.deepEqual((await service.getCase("p1", "permission", "0001")).folder, ["合同管理", "经营合同"]);
  assert.equal((await service.list("p1", { folder: "合同管理/经营合同" })).catalog.total, 3);
  await assert.rejects(service.moveCase("p1", "permission", "系统管理/权限", permission.assetHash), /已变化/);
  await assert.rejects(service.moveCase("p1", "permission", "../x", moved.assetHash), /目录/);
  const reset = await service.moveCase("p1", "permission", "", moved.assetHash);
  assert.deepEqual(reset.folder, []);
  assert.deepEqual((await service.getCase("p1", "permission", "0001")).folder, ["系统管理", "权限"]);
});

test("正式版本和新候选分开，展开准确版本并核对脚本及说明哈希", async (t) => {
  const { service, save } = await setup(t);
  await save("demo", { formal: true });
  const { dest } = await save("demo", { revision: "0002", title: "新候选" });
  await save("candidate");
  const items = (await service.list("p1")).catalog.cases;
  const formal = items.find((item) => item.caseId === "demo");
  assert.equal(formal.currentRevision, "0001");
  assert.equal(formal.title, "demo");
  assert.deepEqual(formal.candidates, ["0002"]);
  assert.equal(formal.runnable, true);
  assert.equal(items.find((item) => item.caseId === "candidate").runnable, false);
  const detail = await service.getCase("p1", "demo", "0002");
  assert.equal(detail.meta.title, "新候选");
  assert.equal(detail.revisions.length, 2);
  assert.equal(detail.assetHash, formal.assetHash);
  await fs.writeFile(path.join(dest, "case.spec.cjs"), "tampered");
  await assert.rejects(service.getCase("p1", "demo", "0002"), /脚本已变更/);
  await fs.writeFile(path.join(dest, "case.json"), "{}");
  await assert.rejects(service.getCase("p1", "demo", "0002"), /说明已变更/);
});

test("最近结果仅关联当前正式 revision 的回归，候选验证、旧格式和其他版本不冒充", async (t) => {
  const { service, save, run } = await setup(t);
  await save("demo", { formal: true });
  await save("demo", { revision: "0002" });
  await run("run-old", { status: "failed", finishedAt: "2026-11-08T10:00:00Z" });
  await run("run-new", { status: "passed" });
  await run("run-candidate", { revision: "0002", status: "failed", finishedAt: "2026-11-10T10:00:00Z" });
  await run("run-validate", { purpose: "validate", status: "failed", finishedAt: "2026-11-11T10:00:00Z" });
  await run("run-legacy", { workflow: "old", status: "failed", finishedAt: "2026-11-12T10:00:00Z" });
  const item = (await service.list("p1")).catalog.cases[0];
  assert.equal(item.lastResult.runId, "run-new");
  assert.equal(item.lastResult.status, "passed");
  assert.equal(item.lastResult.revision, "0001");
});

test("手动用例可创建、编辑、筛选和删除，但不会被当成可执行正式版本", async (t) => {
  const { service, workspace } = await setup(t);
  const created = await service.createManualCase("p1", {
    title: "合同归档后的只读校验",
    folder: "合同管理/合同归档",
    role: "合同管理员",
    priority: "P0",
    description: "验证合同归档后不再提供编辑和删除入口。",
    steps: ["进入合同详情", "点击归档", "返回列表检查操作入口"],
    expected: "归档后详情只读，编辑与删除入口隐藏。",
  });
  assert.match(created.caseId, /^case-/);
  assert.equal(created.revision, "0001");
  assert.deepEqual(created.folder, ["合同管理", "合同归档"]);
  const storedAsset = JSON.parse(await fs.readFile(path.join(workspace, "qa/ui/cases", created.caseId, "asset.json"), "utf8"));
  const storedSpec = await fs.readFile(path.join(workspace, "qa/ui/cases", created.caseId, "revisions/0001/case.spec.cjs"), "utf8");
  assert.equal(storedAsset.currentRevision, null);
  assert.equal(storedAsset.origin, "manual");
  assert.equal(storedAsset.revisions[0].origin, "manual");
  assert.match(storedSpec, /test\.skip/);

  await assert.rejects(service.createManualCase("p1", { title: "" }), /标题/);
  await assert.rejects(service.createManualCase("p1", { title: "目录越界", folder: "../x" }), /目录/);

  const manual = (await service.list("p1", { filter: "manual", sort: "updated" })).catalog;
  assert.equal(manual.filterCounts.manual, 1);
  assert.equal(manual.filterCounts.verified, 0);
  assert.equal(manual.total, 1);
  const item = manual.cases[0];
  assert.equal(item.caseId, created.caseId);
  assert.equal(item.manual, true);
  assert.equal(item.runnable, false);
  assert.deepEqual(item.candidates, []);
  assert.equal(item.priority, "P0");
  assert.equal(item.description, "验证合同归档后不再提供编辑和删除入口。");
  assert.deepEqual(item.folderPath, ["合同管理", "合同归档"]);

  const detail = await service.getCase("p1", created.caseId, "0001");
  assert.equal(detail.origin, "manual");
  assert.equal(detail.manual, true);
  assert.equal(detail.meta.project.id, "p1");
  assert.equal(detail.meta.origin, "manual");
  assert.equal(detail.meta.steps.length, 3);
  assert.equal(detail.meta.steps[0].text, "进入合同详情");
  assert.equal(detail.meta.expected[0].text, "归档后详情只读，编辑与删除入口隐藏。");
  assert.equal(detail.meta.assertions.length, 1);

  const updated = await service.updateManualCase("p1", created.caseId, {
    title: "合同归档后的只读校验（补充）",
    folder: "合同管理/合同归档/2026",
    role: "合同管理员",
    priority: "P1",
    description: "补充归档后的列表状态校验。",
    steps: ["进入合同详情", "点击归档"],
    expected: "归档后详情只读。",
  }, created.assetHash);
  assert.equal(updated.revision, "0002");
  assert.deepEqual(updated.folder, ["合同管理", "合同归档", "2026"]);
  const detail2 = await service.getCase("p1", created.caseId, "0002");
  assert.equal(detail2.meta.title, "合同归档后的只读校验（补充）");
  assert.equal(detail2.folder.join("/"), "合同管理/合同归档/2026");
  assert.equal(detail2.revisions.length, 2);
  assert.equal(detail2.revisions[1].origin, "manual");

  await assert.rejects(service.updateManualCase("p1", created.caseId, {
    title: "过期修改", folder: "", role: "", priority: "P2", description: "", steps: [], expected: "",
  }, created.assetHash), /已变化/);

  await (async () => {
    const directory = path.join(workspace, "qa/ui/cases/ai-generated");
    await fs.mkdir(path.join(directory, "revisions/0001"), { recursive: true });
    const meta = { schema: "qa-ui-case/v1", caseId: "ai-generated", title: "Agent 用例", modulePath: ["自动"], project: { id: "p1" }, taskId: "task-ai",
      targetUrl: "https://demo.invalid", role: "管理员", initialState: "初态", dataStrategy: "read-only", cleanup: "none",
      expected: [], steps: [], assertions: [] };
    const bytes = JSON.stringify(meta);
    const script = "test('ai', async () => {});";
    await fs.writeFile(path.join(directory, "revisions/0001/case.json"), bytes);
    await fs.writeFile(path.join(directory, "revisions/0001/case.spec.cjs"), script);
    const asset = { schema: "qa-ui-asset/v1", caseId: "ai-generated", currentRevision: "0001", revisions: [
      { revision: "0001", taskId: "task-ai", validatedRunId: "run-1", hashes: { "case.json": hash(bytes), "case.spec.cjs": hash(script) } },
    ] };
    await fs.writeFile(path.join(directory, "asset.json"), JSON.stringify(asset));
  })();
  const ai = (await service.list("p1")).catalog.cases.find((entry) => entry.caseId === "ai-generated");
  assert.ok(ai);
  await assert.rejects(service.updateManualCase("p1", "ai-generated", {
    title: "不应修改", folder: "", role: "", priority: "P2", description: "", steps: [], expected: "",
  }, ai.assetHash), /只有手动用例/);

  const latest = (await service.list("p1", { filter: "manual" })).catalog.cases[0];
  await service.removeCase("p1", created.caseId, latest.assetHash);
  await assert.rejects(fs.access(path.join(workspace, "qa/ui/cases", created.caseId)), { code: "ENOENT" });
  assert.equal((await service.list("p1", { filter: "manual" })).catalog.total, 0);
});

test("旧 UI 资产不读取；其他 qa/data 文件继续列表和删除", async (t) => {
  const { service, workspace } = await setup(t);
  await fs.mkdir(path.join(workspace, "qa/data/ui/cases"), { recursive: true });
  await fs.writeFile(path.join(workspace, "qa/data/ui/cases/old.asset.json"), "not json");
  await fs.writeFile(path.join(workspace, "qa/data/sample.json"), "{}");
  await fs.writeFile(path.join(workspace, "qa/data/.hidden"), "secret");
  await fs.mkdir(path.join(workspace, "qa/ui/cases"), { recursive: true });
  await fs.writeFile(path.join(workspace, "qa/ui/cases/old.asset.json"), "not json");
  await fs.mkdir(path.join(workspace, "qa/ui/cases/old-directory"));
  await fs.writeFile(path.join(workspace, "qa/ui/cases/old-directory/asset.json"), JSON.stringify({ schema: "old" }));
  await fs.mkdir(path.join(workspace, "qa/ui/cases/no-index"));
  const listed = await service.list("p1");
  assert.deepEqual(listed.items.map((item) => item.path), ["sample.json"]);
  assert.equal(listed.catalog.total, 0);
  await assert.rejects(service.getCase("p1", "old-directory", "0001"), /仅支持新版/);
  await assert.rejects(service.remove("p1", "ui/cases/old.asset.json"), /旧 UI/);
  await service.remove("p1", "sample.json");
  assert.equal((await service.list("p1")).items.length, 0);
});

test("拒绝越界、目录、链接及未登记项目或 revision", async (t) => {
  const { service, save, workspace } = await setup(t);
  const { directory } = await save("demo");
  for (const input of ["../outside", "/tmp/x", "C:\\x", "x/../y", "", ".hidden", "a\0b"]) await assert.rejects(service.remove("p1", input), /路径无效/);
  await assert.rejects(service.getCase("p1", "../demo", "0001"), /编号无效/);
  await assert.rejects(service.getCase("p1", "demo", "0002"), /未登记/);
  await assert.rejects(service.getCase("p1", "demo", "1"), /版本无效/);
  await assert.rejects(service.list("missing"), /未找到/);
  await fs.symlink(directory, path.join(workspace, "qa/ui/cases/link"));
  await assert.rejects(service.getCase("p1", "link", "0001"), /符号链接/);
  await assert.rejects(service.moveCase("p1", "link", "合同管理", "0".repeat(64)), /符号链接/);
  await fs.mkdir(path.join(workspace, "qa/data"), { recursive: true });
  await fs.symlink(directory, path.join(workspace, "qa/data/link"));
  await assert.rejects(service.remove("p1", "link/asset.json"), /符号链接/);
  await fs.mkdir(path.join(workspace, "qa/data/folder"));
  await assert.rejects(service.remove("p1", "folder"), /只能删除/);
});

test("整例删除拒绝活动锁与过期索引；成功后全部版本删除、来源和历史快照保留", async (t) => {
  const { service, save, run, workspace } = await setup(t);
  const { directory } = await save("demo", { formal: true });
  await run("run-history");
  await fs.mkdir(path.join(workspace, "qa/ui/tasks/task-1"), { recursive: true });
  await fs.writeFile(path.join(workspace, "qa/ui/tasks/task-1/task.json"), "{}");
  const original = (await service.list("p1")).catalog.cases[0];
  const lock = path.join(workspace, "qa/ui/.workflow.lock");
  await fs.writeFile(lock, "active");
  await assert.rejects(service.removeCase("p1", "demo", original.assetHash), /已有 UI 任务/);
  assert.equal(await fs.readFile(lock, "utf8"), "active");
  await fs.unlink(lock);
  await save("demo", { revision: "0002" });
  await assert.rejects(service.removeCase("p1", "demo", original.assetHash), /版本已变化/);
  const current = (await service.list("p1")).catalog.cases[0];
  await service.removeCase("p1", "demo", current.assetHash);
  await assert.rejects(fs.access(directory), { code: "ENOENT" });
  await assert.rejects(fs.access(lock), { code: "ENOENT" });
  await fs.access(path.join(workspace, "qa/ui/runs/run-history/summary.json"));
  await fs.access(path.join(workspace, "qa/ui/tasks/task-1/task.json"));
});

test("不能通过其他项目或篡改版本读取和删除用例", async (t) => {
  const { service, save, workspace } = await setup(t);
  const { directory } = await save("foreign", { projectId: "other" });
  await assert.rejects(service.list("p1"), /项目或来源不匹配/);
  await assert.rejects(service.getCase("p1", "foreign", "0001"), /项目或来源不匹配/);
  const bytes = await fs.readFile(path.join(directory, "asset.json"));
  await assert.rejects(service.removeCase("p1", "foreign", hash(bytes)), /不属于/);
  await fs.writeFile(path.join(directory, "revisions/0001/case.json"), "{}");
  await assert.rejects(service.removeCase("p1", "foreign", hash(bytes)), /说明已变更/);
  await fs.access(directory);
  await assert.rejects(fs.access(path.join(workspace, "qa/ui/.workflow.lock")), { code: "ENOENT" });
});

test("缺失目录只返回空态，不创建目录；参数与摘要大小检查保留", async (t) => {
  const { service, workspace, save, run } = await setup(t);
  const empty = await service.list("p1");
  assert.equal(empty.available, false);
  assert.equal(empty.catalog.total, 0);
  assert.deepEqual(await fs.readdir(workspace), []);
  for (const options of [{ page: 0 }, { page: 1.5 }, { query: 1 }, null]) await assert.rejects(service.list("p1", options), /参数无效/);
  await save("demo");
  await run("run-large");
  await fs.writeFile(path.join(workspace, "qa/ui/runs/run-large/summary.json"), " ".repeat(1024 * 1024 + 1));
  await assert.rejects(service.list("p1"), /过大/);
});
