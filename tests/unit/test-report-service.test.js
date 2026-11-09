const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, writeFile, rm, symlink, access, realpath, readFile } = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");
const { createTestReportService } = require("../../src/main/services/test-report-service.js");

async function setup(t) {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "agent-test-report-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const store = createProjectStore(path.join(base, "config", "projects.json"));
  const project = await store.add(workspace);
  return { base, workspace, project, service: createTestReportService(store) };
}

async function writeSummary(context, kind, id, overrides = {}) {
  const directory = path.join(context.workspace, "qa", kind, "runs", id);
  await mkdir(directory, { recursive: true });
  const summary = {
    schema: "qa-report/v1", kind, runId: id, status: "passed",
    finishedAt: "2026-11-09T06:00:00Z", project: { id: context.project.id }, workspace: context.workspace,
    ...(kind === "ui" ? { workflow: "browser-use-playwright", purpose: "regression", caseIds: ["case-a"],
      revisions: { "case-a": "0002" }, sourceTaskIds: { "case-a": "task-a" },
      caseModules: { "case-a": ["合同管理", "经营合同"] } } : {}),
    tests: [{ title: "通过", status: "passed" }], ...overrides,
  };
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary));
  await writeFile(path.join(directory, "task.json"), JSON.stringify({ ...summary, status: "passed" }));
  return directory;
}

test("新 UI 归属和版本严格校验，旧 UI 退出，接口旧格式仍可读取且不回看旧资产", async (t) => {
  const c = await setup(t);
  await writeSummary(c, "ui", "new");
  const invalid = [
    { workflow: undefined }, { schema: undefined }, { kind: "api" }, { purpose: "repair" },
    { project: { id: "other" } }, { workspace: "/other" }, { runId: "different" },
    { revisions: { "case-a": 1000 } }, { sourceTaskIds: {} },
  ];
  for (const [index, value] of invalid.entries()) {
    const id = `invalid-${index}`;
    await writeSummary(c, "ui", id, value);
    await assert.rejects(c.service.get(c.project.id, "ui", id), /格式或项目/);
  }
  await writeSummary(c, "api", "legacy-api", { schema: undefined, kind: undefined, caseIds: ["case-a"], finishedAt: "2026-11-09T07:00:00Z" });
  const oldCases = path.join(c.workspace, "qa/data/ui/cases");
  await mkdir(oldCases, { recursive: true });
  await writeFile(path.join(oldCases, "case-a.asset.json"), JSON.stringify({ caseMeta: { modulePath: ["旧模块"] } }));
  const result = await c.service.list(c.project.id);
  assert.deepEqual(result.reports.map((item) => item.id), ["legacy-api", "new"]);
  assert.equal(result.invalid, invalid.length);
  assert.equal(result.reports[0].kind, "api");
  assert.equal(result.reports[0].moduleName, "");
  assert.equal(result.reports[1].moduleName, "经营合同");
  assert.equal(result.totals.total, 2);
  assert.equal(result.reports[1].tests, undefined, "列表不携带逐例错误或附件");
  const detail = await c.service.get(c.project.id, "ui", "new");
  assert.deepEqual(detail.selections, [{ caseId: "case-a", revision: "0002", taskId: "task-a" }]);
  assert.equal(detail.purpose, "regression");
});

test("扫描超过 200 批次，完整排序、类型筛选后每页 50 条且页码收敛", async (t) => {
  const c = await setup(t);
  for (let index = 0; index < 205; index += 1) {
    await writeSummary(c, "ui", `run-${String(index).padStart(3, "0")}`, { finishedAt: new Date(Date.UTC(2026, 10, 9, 0, index)).toISOString() });
  }
  await writeSummary(c, "api", "old-api", { finishedAt: "2026-01-01T00:00:00Z" });
  const first = await c.service.list(c.project.id);
  assert.equal(first.reports.length, 50);
  assert.equal(first.reports[0].id, "run-204");
  assert.equal(first.totals.total, 206);
  const last = await c.service.list(c.project.id, { kind: "ui", page: 99 });
  assert.deepEqual(last.pagination, { total: 205, page: 5, pages: 5, pageSize: 50 });
  assert.deepEqual(last.reports.map((item) => item.id), ["run-004", "run-003", "run-002", "run-001", "run-000"]);
  const api = await c.service.list(c.project.id, { kind: "api" });
  assert.equal(api.reports[0].id, "old-api", "类型筛选不能局限于第一页");
  assert.equal(api.pagination.total, 1);
  assert.equal(api.totals.ui, 205);
  await assert.rejects(c.service.list(c.project.id, { page: -1 }), /页码/);
  await assert.rejects(c.service.list(c.project.id, { kind: "bad" }), /类型/);
});

test("逐例结果超过 100 条不丢失，失败摘要独立于当前页且不暴露附件路径", async (t) => {
  const c = await setup(t);
  const tests = Array.from({ length: 103 }, (_, index) => ({ title: `用例 ${index + 1}`, status: index === 102 ? "failed" : "passed",
    errors: index === 102 ? [{ message: "业务结果不符" }] : [],
    attachments: [{ name: "result.png", contentType: "image/png", path: "/private/secret.png" }] }));
  await writeSummary(c, "ui", "many", { tests, status: "failed" });
  const first = await c.service.get(c.project.id, "ui", "many");
  assert.equal(first.tests.length, 50);
  assert.equal(first.failureCount, 1);
  assert.equal(first.failures[0].title, "用例 103");
  assert.equal(first.failures[0].error, "业务结果不符");
  assert.deepEqual(first.failures[0].attachments, [{ name: "result.png", contentType: "image/png" }]);
  const pages = await Promise.all([2, 3].map((page) => c.service.get(c.project.id, "ui", "many", { page })));
  assert.deepEqual([...first.tests, ...pages.flatMap((item) => item.tests)].map((item) => item.title), tests.map((item) => item.title));
  assert.deepEqual(pages[1].pagination, { total: 103, page: 3, pages: 3, pageSize: 50 });
  assert.equal(first.counts.failed, 1);
  await assert.rejects(c.service.get(c.project.id, "ui", "many", { page: "2" }), /页码/);
});

test("路径、链接和摘要大小边界拒绝，损坏摘要不推断结果", async (t) => {
  const c = await setup(t);
  await assert.rejects(c.service.get(c.project.id, "other", "ok"), /类型/);
  await assert.rejects(c.service.get(c.project.id, "ui", "../ok"), /编号/);
  await assert.rejects(c.service.get(c.project.id, "ui", "missing"), /不存在/);
  for (const [id, value] of [["bad", "{broken"], ["large", " ".repeat(2 * 1024 * 1024 + 1)]]) {
    const dir = await writeSummary(c, "ui", id);
    await writeFile(path.join(dir, "summary.json"), value);
    await assert.rejects(c.service.get(c.project.id, "ui", id), /不存在|格式/);
  }
  const outside = path.join(c.base, "outside.json");
  await writeFile(outside, "{}");
  const dir = await writeSummary(c, "ui", "link");
  await rm(path.join(dir, "summary.json"));
  await symlink(outside, path.join(dir, "summary.json"));
  await assert.rejects(c.service.get(c.project.id, "ui", "link"), /不存在|格式/);
  await symlink(dir, path.join(c.workspace, "qa/ui/runs/dir-link"));
  await assert.rejects(c.service.get(c.project.id, "ui", "dir-link"), /目录无效/);
  assert.equal((await c.service.list(c.project.id)).invalid, 3);
  await rm(path.join(c.workspace, "qa/ui/runs"), { recursive: true });
  await symlink(c.base, path.join(c.workspace, "qa/ui/runs"));
  await assert.rejects(c.service.list(c.project.id), /符号链接/);
});

test("UI 删除复用工作区锁，保护所有版本验证引用、活动任务和损坏索引", async (t) => {
  const c = await setup(t);
  const dir = await writeSummary(c, "ui", "protected");
  const lock = path.join(c.workspace, "qa/ui/.workflow.lock");
  await writeFile(lock, "active");
  await assert.rejects(c.service.remove(c.project.id, "ui", "protected"), /已有 UI 任务/);
  assert.equal(await readFile(lock, "utf8"), "active");
  await rm(lock);
  const cases = path.join(c.workspace, "qa/ui/cases/case-a");
  await mkdir(cases, { recursive: true });
  for (const field of ["validationRunId", "validatedRunId"]) {
    await writeFile(path.join(cases, "asset.json"), JSON.stringify({ schema: "qa-ui-asset/v1", caseId: "case-a", currentRevision: null,
      revisions: [{ revision: "0001", [field]: "protected" }] }));
    await assert.rejects(c.service.remove(c.project.id, "ui", "protected"), /仍被用例版本/);
    await access(path.join(dir, "summary.json"));
    await assert.rejects(access(lock), /ENOENT/);
  }
  await writeFile(path.join(cases, "asset.json"), "{}");
  await assert.rejects(c.service.remove(c.project.id, "ui", "protected"), /无效版本索引/);
  await rm(cases, { recursive: true });
  const taskFile = path.join(dir, "task.json");
  const task = JSON.parse(await readFile(taskFile));
  await writeFile(taskFile, JSON.stringify({ ...task, status: "prepared" }));
  await assert.rejects(c.service.remove(c.project.id, "ui", "protected"), /正在执行或未收尾/);
  await writeFile(taskFile, JSON.stringify({ ...task, project: { id: "other" } }));
  await assert.rejects(c.service.remove(c.project.id, "ui", "protected"), /归属无效/);
  await writeFile(taskFile, JSON.stringify(task));
  await writeFile(path.join(dir, "evidence.png"), "evidence");
  const source = path.join(c.workspace, "qa/ui/tasks/task-a");
  await mkdir(source, { recursive: true });
  await writeFile(path.join(source, "task.json"), "source");
  await writeSummary(c, "api", "keep");
  assert.deepEqual(await c.service.remove(c.project.id, "ui", "protected"), { kind: "ui", id: "protected" });
  await assert.rejects(access(dir), /ENOENT/);
  assert.equal(await readFile(path.join(source, "task.json"), "utf8"), "source");
  await access(path.join(c.workspace, "qa/api/runs/keep/summary.json"));
});

test("接口报告删除仍保留旧无任务格式，但不能忽略活动、损坏或链接任务", async (t) => {
  const c = await setup(t);
  const dir = await writeSummary(c, "api", "api");
  const task = path.join(dir, "task.json");
  await writeFile(task, JSON.stringify({ status: "running" }));
  await assert.rejects(c.service.remove(c.project.id, "api", "api"), /正在执行/);
  await writeFile(task, "{bad");
  await assert.rejects(c.service.remove(c.project.id, "api", "api"), SyntaxError);
  await rm(task);
  await symlink(path.join(dir, "summary.json"), task);
  await assert.rejects(c.service.remove(c.project.id, "api", "api"), /任务文件无效/);
  await rm(task);
  assert.deepEqual(await c.service.remove(c.project.id, "api", "api"), { kind: "api", id: "api" });
});

test("修复批次保留父批次与补丁摘要，普通批次为空", async (t) => {
  const c = await setup(t);
  await writeSummary(c, "ui", "repair-run", { purpose: "validate", parentRunId: "run-failed", patchSummary: "修正结果定位器" });
  const listed = (await c.service.list(c.project.id)).reports[0];
  assert.equal(listed.parentRunId, "run-failed");
  assert.equal(listed.patchSummary, "修正结果定位器");
  const detail = await c.service.get(c.project.id, "ui", "repair-run");
  assert.equal(detail.parentRunId, "run-failed");
  assert.equal(detail.patchSummary, "修正结果定位器");
  await writeSummary(c, "ui", "plain-run", { finishedAt: "2026-11-09T08:00:00Z" });
  const plain = (await c.service.list(c.project.id)).reports.find((item) => item.id === "plain-run");
  assert.equal(plain.parentRunId, "");
  assert.equal(plain.patchSummary, "");
});

test("隔离写批次保留数据策略与写授权", async (t) => {
  const c = await setup(t);
  await writeSummary(c, "ui", "write-run", { purpose: "validate", dataStrategy: "isolated-write", dataCleanup: "in-test",
    writeAuthorization: { kind: "user", reference: "受控写夹具" } });
  const detail = await c.service.get(c.project.id, "ui", "write-run");
  assert.equal(detail.dataStrategy, "isolated-write");
  assert.equal(detail.dataCleanup, "in-test");
  assert.deepEqual(detail.writeAuthorization, { kind: "user", reference: "受控写夹具" });
  const listed = (await c.service.list(c.project.id)).reports.find((item) => item.id === "write-run");
  assert.equal(listed.dataStrategy, "isolated-write");
  await writeSummary(c, "ui", "read-run");
  const read = await c.service.get(c.project.id, "ui", "read-run");
  assert.equal(read.dataStrategy, "");
  assert.equal(read.writeAuthorization, null);
});

test("空目录返回稳定分页，项目缺失明确拒绝", async (t) => {
  const c = await setup(t);
  const result = await c.service.list(c.project.id);
  assert.equal(result.available, false);
  assert.deepEqual(result.reports, []);
  assert.equal(result.totals.total, 0);
  assert.deepEqual(result.pagination, { total: 0, page: 1, pages: 1, pageSize: 50 });
  await assert.rejects(c.service.list("missing"), /未找到该项目环境/);
});
