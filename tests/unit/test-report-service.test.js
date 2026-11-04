const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, writeFile, rm, symlink } = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");
const { createTestReportService } = require("../../src/main/services/test-report-service.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-test-report-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace, { recursive: true });
  const store = createProjectStore(path.join(base, "config", "projects.json"));
  const project = await store.add(workspace);
  const service = createTestReportService(store);
  return { base, workspace, store, project, service };
}

async function writeSummary(workspace, kind, id, summary) {
  const directory = path.join(workspace, "qa", kind, "runs", id);
  await mkdir(directory, { recursive: true });
  await writeFile(path.join(directory, "summary.json"), JSON.stringify(summary, null, 2));
}

test("聚合 UI 与接口报告并按结束时间排序", async (t) => {
  const { workspace, project, service } = await setup(t);
  await writeSummary(workspace, "ui", "ui-run", {
    schema: "qa-report/v1",
    kind: "ui",
    runId: "ui-run",
    status: "failed",
    startedAt: "2026-11-04T06:00:00.000Z",
    finishedAt: "2026-11-04T06:01:00.000Z",
    targetUrl: "https://example.test/ui",
    project: { id: "pms", name: "项目管理系统" },
    caseIds: ["case-a"],
    testCount: 2,
    counts: { passed: 1, failed: 1 },
    cleanup: "deleted",
    tracePolicy: "disabled-for-private-auth",
    problems: ["附件缺失：a.png"],
    tests: [
      { title: "A 通过", file: "a.spec.cjs", line: 10, status: "passed", durationMs: 1200 },
      {
        title: "B 失败",
        file: "a.spec.cjs",
        line: 20,
        status: "failed",
        durationMs: 800,
        errors: [{ message: "expected 1 to be 2" }],
      },
    ],
    versions: { node: "22.19.0", playwright: "1.64.1", files: [] },
  });
  await writeSummary(workspace, "api", "api-run", {
    schema: "qa-report/v1",
    kind: "api",
    runId: "api-run",
    status: "passed",
    startedAt: "2026-11-04T06:02:00.000Z",
    finishedAt: "2026-11-04T06:03:00.000Z",
    project: { id: "pms", name: "项目管理系统" },
    caseIds: ["api-case"],
    testCount: 1,
    counts: { passed: 1 },
    cleanup: "not-needed",
    tests: [{ title: "接口成功", status: "passed", durationMs: 30 }],
  });
  await writeSummary(workspace, "ui", "legacy-run", {
    runId: "legacy-run",
    status: "passed",
    startedAt: "2026-11-04T05:00:00.000Z",
    finishedAt: "2026-11-04T05:01:00.000Z",
    tests: [{ title: "旧批次", status: "passed" }],
  });
  await mkdir(path.join(workspace, "qa", "ui", "runs", "broken"), { recursive: true });
  await writeFile(path.join(workspace, "qa", "ui", "runs", "broken", "summary.json"), "{broken");

  const result = await service.list(project.id);
  assert.equal(result.available, true);
  assert.equal(result.invalid, 1);
  assert.deepEqual(result.reports.map((report) => report.runId), ["api-run", "ui-run", "legacy-run"]);
  assert.equal(result.reports[0].kind, "api");
  assert.equal(result.reports[1].kind, "ui");
  assert.equal(result.reports[2].kind, "ui", "旧批次按目录推断为 UI");
  assert.equal(result.reports[1].testCount, 2);
  assert.deepEqual(result.reports[1].counts, { passed: 1, failed: 1 });
  assert.equal(result.reports[1].summaryPath, "qa/ui/runs/ui-run/summary.json");
  assert.equal(result.reports[1].problemsCount, 1);
  assert.equal(result.reports[1].durationMs, 60000);
  assert.deepEqual(result.totals, {
    total: 3,
    ui: 2,
    api: 1,
    passed: 2,
    failed: 1,
    incomplete: 0,
    cancelled: 0,
  });
});

test("读取单份报告详情并规范化失败信息", async (t) => {
  const { workspace, project, service } = await setup(t);
  await writeSummary(workspace, "ui", "ui-detail", {
    runId: "ui-detail",
    status: "failed",
    startedAt: "2026-11-04T06:00:00.000Z",
    finishedAt: "2026-11-04T06:01:00.000Z",
    project: { id: "pms", name: "项目管理系统" },
    counts: { failed: 1 },
    tests: [{
      title: "失败用例",
      file: "a.spec.cjs",
      line: 7,
      status: "failed",
      durationMs: 50,
      errors: [{ message: "expect(received).toBe(expected)" }],
      attachments: [{ name: "failure.png", contentType: "image/png" }],
    }],
    problems: ["控件不可见"],
    versions: { node: "22.19.0", playwright: "1.64.1", files: [{ path: "a" }] },
    limits: "仅临时夹具。",
  });

  const detail = await service.get(project.id, "ui", "ui-detail");
  assert.equal(detail.status, "failed");
  assert.equal(detail.testCount, 1);
  assert.equal(detail.tests[0].title, "失败用例");
  assert.equal(detail.tests[0].error, "expect(received).toBe(expected)");
  assert.equal(detail.tests[0].attachments[0].name, "failure.png");
  assert.deepEqual(detail.problems, ["控件不可见"]);
  assert.equal(detail.versions.files, 1);
  assert.equal(detail.summaryPath, "qa/ui/runs/ui-detail/summary.json");
});

test("拒绝无效类型、路径穿越、缺失报告和符号链接摘要", async (t) => {
  const { workspace, project, service, base } = await setup(t);
  await writeSummary(workspace, "ui", "ui-ok", {
    runId: "ui-ok",
    status: "passed",
    tests: [{ title: "ok", status: "passed" }],
  });
  await assert.rejects(service.get(project.id, "other", "ui-ok"), /类型无效/);
  await assert.rejects(service.get(project.id, "ui", "../ui-ok"), /编号无效/);
  await assert.rejects(service.get(project.id, "ui", "missing"), /不存在/);

  const outside = path.join(base, "outside.json");
  await writeFile(outside, JSON.stringify({ runId: "outside", status: "passed", tests: [] }));
  const linkDir = path.join(workspace, "qa", "ui", "runs", "ui-link");
  await mkdir(linkDir, { recursive: true });
  await symlink(outside, path.join(linkDir, "summary.json"));
  await assert.rejects(service.get(project.id, "ui", "ui-link"), /不存在|无效/);
});

test("没有运行目录时返回空报告集合", async (t) => {
  const { service, project, base, store } = await setup(t);
  const emptyWorkspace = path.join(base, "empty");
  await mkdir(emptyWorkspace, { recursive: true });
  const emptyProject = await store.add(emptyWorkspace);
  const result = await service.list(emptyProject.id);
  assert.deepEqual(result, {
    available: false,
    reports: [],
    truncated: false,
    invalid: 0,
    totals: { total: 0, ui: 0, api: 0, passed: 0, failed: 0, incomplete: 0, cancelled: 0 },
  });
  await assert.rejects(service.list("missing"), /未找到该项目环境/);
});
