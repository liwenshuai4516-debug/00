const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, writeFile, readFile, rm, symlink, access, utimes,
} = require("node:fs/promises");
const { createProjectStore } = require("../../src/main/storage/project-store.js");
const {
  createTestDataService,
} = require("../../src/main/services/test-data-service.js");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-test-data-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  const dataRoot = path.join(workspace, "qa", "data");
  await mkdir(path.join(dataRoot, "ui", "cases"), { recursive: true });
  await writeFile(path.join(dataRoot, "ui", "cases", "demo.spec.cjs"), "console.log('demo');\n");
  await writeFile(path.join(dataRoot, "ui", "cases", "demo.md"), "# demo\n");
  await writeFile(path.join(dataRoot, "root.txt"), "root\n");
  await writeFile(path.join(dataRoot, ".hidden"), "hidden\n");

  const outside = path.join(base, "outside.txt");
  await writeFile(outside, "outside\n");
  await symlink(outside, path.join(dataRoot, "ui", "cases", "link.txt"));

  const store = createProjectStore(path.join(base, "config", "projects.json"));
  const project = await store.add(workspace);
  const service = createTestDataService(store);
  return { base, workspace, dataRoot, store, project, service, outside };
}

test("列出 qa/data 下的相对路径并跳过隐藏文件和符号链接", async (t) => {
  const { service, project } = await setup(t);
  const result = await service.list(project.id);

  assert.equal(result.available, true);
  assert.equal(result.truncated, false);
  assert.deepEqual(
    result.items.map((item) => item.path),
    ["ui/cases/demo.md", "ui/cases/demo.spec.cjs", "root.txt"],
  );
  for (const item of result.items) {
    assert.equal(path.isAbsolute(item.path), false);
    assert.equal(item.path.startsWith(".."), false);
  }
  assert.equal(result.items.some((item) => item.name === ".hidden"), false);
  assert.equal(result.items.some((item) => item.name === "link.txt"), false);
  const spec = result.items.find((item) => item.name === "demo.spec.cjs");
  assert.equal(spec.category, "ui");
  assert.ok(spec.size > 0);
  assert.ok(Number.isFinite(spec.modifiedAt));
});

test("按 qa-ui-case 元数据归组模块、用例与断言", async (t) => {
  const { service, project, dataRoot, workspace } = await setup(t);
  const cases = path.join(dataRoot, "ui", "cases");
  await writeFile(path.join(cases, "权限.asset.json"), JSON.stringify({
    caseId: "权限",
    recordedAt: "2026-11-04T06:48:43.222Z",
    caseMeta: {
      schema: "qa-ui-case/v1",
      caseId: "权限",
      project: { id: "pms", name: "项目管理系统" },
      page: "/pms/Contract",
      role: "管理员",
      dataPolicy: "read-only",
      tags: ["合同管理", "列表"],
      cases: [
        {
          name: "T1 列表可见", type: "functional", priority: "P2",
          assertions: [
            { id: "A1", kind: "business", text: "列表出现", source: "页面基线" },
          ],
        },
        {
          name: "T2 权限拒绝", type: "permission", priority: "P0",
          assertions: [
            { id: "A2", kind: "guard", text: "无权限不可见", source: "需求声明" },
            { id: "A3", kind: "business", text: "列表为空", source: "页面基线" },
          ],
        },
      ],
    },
  }));
  await writeFile(path.join(cases, "legacy.asset.json"), JSON.stringify({ caseId: "legacy" }));
  const runDir = path.join(workspace, "qa", "ui", "runs", "run-1");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify({
    runId: "run-1",
    status: "failed",
    startedAt: "2026-11-04T06:50:00.000Z",
    finishedAt: "2026-11-04T06:51:00.000Z",
    tests: [
      { file: "权限.spec.cjs", title: "权限.spec.cjs > 合同 > T2 权限拒绝", status: "failed", durationMs: 12 },
      { file: "权限.spec.cjs", title: "权限.spec.cjs > 合同 > T1 列表可见", status: "passed", durationMs: 8 },
    ],
  }));

  const result = await service.list(project.id);
  assert.equal(result.catalog.totals.modules, 1);
  assert.equal(result.catalog.totals.cases, 2);
  assert.equal(result.catalog.totals.assertions, 3);
  assert.equal(result.catalog.totals.legacy, 1);
  assert.deepEqual(result.catalog.legacy.map((item) => item.name), ["legacy.asset.json"]);

  const module = result.catalog.modules[0];
  assert.equal(module.title, "合同管理");
  assert.equal(module.page, "/pms/Contract");
  assert.deepEqual(module.tags, ["合同管理", "列表"]);
  assert.deepEqual(module.cases.map((item) => item.name), ["T2 权限拒绝", "T1 列表可见"]);
  assert.equal(module.cases[0].priority, "P0");
  assert.equal(module.cases[0].type, "permission");
  assert.equal(module.cases[0].assertions[0].kind, "guard");
  assert.equal(module.cases[0].assertions[0].source, "需求声明");
  assert.equal(module.cases[0].specPath, "ui/cases/权限.spec.cjs");
  assert.equal(module.cases[0].documentPath, "ui/cases/权限.md");
  assert.equal(module.cases[0].assetPath, "ui/cases/权限.asset.json");
  assert.equal(module.cases[0].lastResult.status, "failed");
  assert.equal(module.cases[0].lastResult.durationMs, 12);
  assert.equal(module.cases[1].lastResult.status, "passed");
  assert.equal(result.catalog.lastRun.runId, "run-1");
  assert.equal(result.catalog.lastRun.status, "failed");
  assert.equal(result.catalog.lastRun.total, 2);
  assert.equal(result.catalog.lastRun.passed, 1);
  assert.equal(result.catalog.lastRun.failed, 1);
});

test("删除单个文件并保留其他测试数据", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const result = await service.remove(project.id, "ui/cases/demo.spec.cjs");
  assert.deepEqual(result, { path: "ui/cases/demo.spec.cjs" });
  await assert.rejects(access(path.join(dataRoot, "ui", "cases", "demo.spec.cjs")));
  assert.match(await readFile(path.join(dataRoot, "ui", "cases", "demo.md"), "utf8"), /demo/);
  assert.match(await readFile(path.join(dataRoot, "root.txt"), "utf8"), /root/);
});

test("拒绝目录穿越、绝对路径、目录、符号链接与缺失文件", async (t) => {
  const { service, project, dataRoot, outside } = await setup(t);
  const invalidPaths = [
    "",
    "../outside.txt",
    "ui/../../outside.txt",
    "..\\outside.txt",
    path.join(dataRoot, "root.txt"),
    "ui",
    "ui/cases",
    "ui/cases/link.txt",
    "ui/cases/missing.txt",
  ];

  for (const relativePath of invalidPaths) {
    await assert.rejects(service.remove(project.id, relativePath));
  }
  assert.equal(await readFile(outside, "utf8"), "outside\n");
  assert.match(await readFile(path.join(dataRoot, "root.txt"), "utf8"), /root/);
});

test("没有 qa/data、未知项目或无效编号明确返回/报错", async (t) => {
  const { service, project, base, store } = await setup(t);
  const emptyWorkspace = path.join(base, "empty");
  await mkdir(emptyWorkspace, { recursive: true });
  const emptyProject = await store.add(emptyWorkspace);
  const empty = await service.list(emptyProject.id);
  assert.deepEqual(empty, {
    available: false,
    truncated: false,
    items: [],
    catalog: {
      modules: [],
      legacy: [],
      truncated: false,
      totals: { modules: 0, cases: 0, assertions: 0, legacy: 0 },
      lastRun: null,
    },
  });

  await assert.rejects(service.list("missing"), /未找到该项目环境/);
  await assert.rejects(service.remove("missing", "root.txt"), /未找到该项目环境/);
  await assert.rejects(service.remove(project.id, "root.txt/child"));
});

test("列表按分类和修改时间稳定排序", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const first = path.join(dataRoot, "ui", "cases", "demo.md");
  const second = path.join(dataRoot, "root.txt");
  await utimes(first, new Date(1000), new Date(1000));
  await utimes(second, new Date(2000), new Date(2000));

  const result = await service.list(project.id);
  assert.deepEqual(
    result.items.map((item) => item.path),
    ["ui/cases/demo.spec.cjs", "ui/cases/demo.md", "root.txt"],
  );
});
