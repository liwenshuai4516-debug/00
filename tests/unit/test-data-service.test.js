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
  const service = createTestDataService({ list: async () => [{ id: "p1", workspaceDir: workspace }] });
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
