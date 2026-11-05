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
          steps: ["打开权限列表", "确认列表可见"],
          assertions: [
            { id: "A1", kind: "business", text: "列表出现", source: "页面基线" },
          ],
        },
        {
          name: "T2 权限拒绝", type: "permission", priority: "P0",
          steps: ["打开权限列表", "以受限角色访问"],
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
  assert.equal(result.catalog.totals.submodules, 0);
  assert.equal(result.catalog.totals.cases, 2);
  assert.equal(result.catalog.totals.assertions, 3);
  assert.equal(result.catalog.totals.legacy, 1);
  assert.deepEqual(result.catalog.legacy.map((item) => item.name), ["legacy.asset.json"]);

  const module = result.catalog.modules[0];
  assert.equal(module.title, "合同管理");
  assert.equal(module.page, "/pms/Contract");
  assert.deepEqual(module.path, ["合同管理"]);
  assert.deepEqual(module.tags, ["合同管理", "列表"]);
  assert.deepEqual(module.cases.map((item) => item.name), ["T2 权限拒绝", "T1 列表可见"]);
  assert.equal(module.cases[0].priority, "P0");
  assert.equal(module.cases[0].type, "permission");
  assert.deepEqual(module.cases[0].steps, ["打开权限列表", "以受限角色访问"]);
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

test("modulePath 构建多级目录并合并同路径用例", async (t) => {
  const { service, project, dataRoot, workspace } = await setup(t);
  const cases = path.join(dataRoot, "ui", "cases");
  const assertion = (text) => [{ id: "A1", kind: "business", text, source: "页面基线" }];
  async function writeAsset(name, modulePath, page, entries) {
    await writeFile(path.join(cases, `${name}.asset.json`), JSON.stringify({
      caseId: name,
      recordedAt: "2026-11-04T06:48:43.222Z",
      caseMeta: {
        schema: "qa-ui-case/v1",
        caseId: name,
        project: { id: "pms", name: "项目管理系统" },
        page,
        modulePath,
        role: "管理员",
        dataPolicy: "read-only",
        tags: ["合同管理", "列表"],
        cases: entries,
      },
    }));
  }
  await writeAsset("经营合同", ["合同管理", "经营合同"], "/pms/OperationContract", [
    { name: "T2 经营合同查询", type: "functional", priority: "P1", assertions: assertion("查询结果") },
  ]);
  await writeAsset("经营合同详情", ["合同管理", "经营合同"], "/pms/OperationContract/Detail", [
    { name: "T3 经营合同详情", type: "functional", priority: "P1", assertions: assertion("详情可见") },
  ]);
  await writeAsset("采购合同", ["合同管理", "采购合同"], "/pms/PurchaseContract", [
    { name: "T1 采购合同列表", type: "functional", priority: "P2", assertions: assertion("列表可见") },
  ]);
  const runDir = path.join(workspace, "qa", "ui", "runs", "run-2");
  await mkdir(runDir, { recursive: true });
  await writeFile(path.join(runDir, "summary.json"), JSON.stringify({
    runId: "run-2",
    status: "failed",
    finishedAt: "2026-11-04T06:52:00.000Z",
    tests: [
      { file: "经营合同.spec.cjs", title: "经营合同.spec.cjs > 合同 > T2 经营合同查询", status: "passed", durationMs: 5 },
      { file: "采购合同.spec.cjs", title: "采购合同.spec.cjs > 合同 > T1 采购合同列表", status: "failed", durationMs: 7 },
    ],
  }));

  const { catalog } = await service.list(project.id);
  assert.equal(catalog.totals.modules, 1);
  assert.equal(catalog.totals.submodules, 2);
  assert.equal(catalog.totals.cases, 3);
  assert.equal(catalog.totals.assertions, 3);

  const root = catalog.modules[0];
  assert.equal(root.title, "合同管理");
  assert.deepEqual(root.path, ["合同管理"]);
  assert.equal(root.depth, 0);
  assert.equal(root.caseCount, 3);
  assert.equal(root.page, "");
  assert.deepEqual(root.children.map((node) => node.title), ["采购合同", "经营合同"]);

  const operation = root.children.find((node) => node.title === "经营合同");
  assert.deepEqual(operation.path, ["合同管理", "经营合同"]);
  assert.equal(operation.depth, 1);
  assert.equal(operation.caseCount, 2);
  assert.deepEqual(operation.pages, ["/pms/OperationContract", "/pms/OperationContract/Detail"]);
  assert.equal(operation.page, "");
  assert.deepEqual(operation.cases.map((item) => item.name), ["T2 经营合同查询", "T3 经营合同详情"]);
  assert.equal(operation.cases[0].page, "/pms/OperationContract");
  assert.equal(operation.cases[0].lastResult.status, "passed");
  assert.equal(operation.cases[1].role, "管理员");

  const purchase = root.children.find((node) => node.title === "采购合同");
  assert.equal(purchase.caseCount, 1);
  assert.equal(purchase.page, "/pms/PurchaseContract");
  assert.equal(purchase.cases[0].lastResult.status, "failed");
  assert.equal(catalog.lastRun.runId, "run-2");
});

test("删除单条用例同步脚本、资产和说明，最后一条删除资产文件", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const cases = path.join(dataRoot, "ui", "cases");
  const caseMeta = {
    schema: "qa-ui-case/v1",
    caseId: "批量",
    project: { id: "pms", name: "项目管理系统" },
    page: "/pms/Contract",
    role: "管理员",
    dataPolicy: "read-only",
    tags: [],
    cases: [
      {
        name: "T1 列表",
        type: "functional",
        priority: "P1",
        steps: ["打开列表"],
        assertions: [{ id: "A1", kind: "business", text: "列表出现", source: "页面基线" }],
      },
      {
        name: "T2 查询",
        type: "functional",
        priority: "P2",
        steps: ["打开列表", "点击查询"],
        assertions: [{ id: "A1", kind: "business", text: "查询完成", source: "页面基线" }],
      },
    ],
    caseCount: 2,
    assertionCount: 2,
  };
  const specPath = path.join(cases, "批量.spec.cjs");
  const assetPath = "ui/cases/批量.asset.json";
  const spec = [
    'const { test } = require("@playwright/test");',
    'test("T1 列表", async ({ page }) => { await page.goto("/"); });',
    'test("T2 查询", async ({ page }) => { await page.goto("/"); });',
    "",
  ].join("\n");
  await writeFile(specPath, spec);
  await writeFile(path.join(cases, "批量.asset.json"), JSON.stringify({ caseId: "批量", sha256: "old", caseMeta }, null, 2));
  await writeFile(path.join(cases, "批量.md"), [
    "# 批量",
    "",
    "```json qa-ui-case",
    JSON.stringify(caseMeta, null, 2),
    "```",
    "",
    "## 用例与断言",
    "",
    "| 用例 | 类型 | 优先级 | 断言 |",
    "| --- | --- | --- | --- |",
    "| T1 列表 | 功能 | P1 | 列表出现 |",
    "| T2 查询 | 功能 | P2 | 查询完成 |",
    "",
  ].join("\n"));

  await assert.rejects(
    service.deleteCases(project.id, [{ assetPath: "../批量.asset.json", caseName: "T1 列表" }]),
    /只能删除/,
  );
  await assert.rejects(
    service.deleteCases(project.id, [{ assetPath, caseName: "不存在" }]),
    /未找到用例/,
  );
  const unchanged = JSON.parse(await readFile(path.join(cases, "批量.asset.json"), "utf8"));
  assert.equal(unchanged.caseMeta.cases.length, 2);
  assert.match(await readFile(specPath, "utf8"), /T1 列表/);
  const first = await service.deleteCases(project.id, [{ assetPath, caseName: "T1 列表" }]);
  assert.deepEqual(first.deleted, [{ assetPath, caseName: "T1 列表" }]);
  const nextSpec = await readFile(specPath, "utf8");
  assert.doesNotMatch(nextSpec, /T1 列表/);
  assert.match(nextSpec, /T2 查询/);
  const asset = JSON.parse(await readFile(path.join(cases, "批量.asset.json"), "utf8"));
  assert.equal(asset.caseMeta.caseCount, 1);
  assert.deepEqual(asset.caseMeta.cases.map((item) => item.name), ["T2 查询"]);
  assert.notEqual(asset.sha256, "old");
  const document = await readFile(path.join(cases, "批量.md"), "utf8");
  assert.doesNotMatch(document, /T1 列表/);
  assert.match(document, /T2 查询/);

  const last = await service.deleteCases(project.id, [{ assetPath, caseName: "T2 查询" }]);
  assert.deepEqual(last.removedAssets, [assetPath]);
  await assert.rejects(access(specPath), /ENOENT/);
  await assert.rejects(access(path.join(cases, "批量.asset.json")), /ENOENT/);
  await assert.rejects(access(path.join(cases, "批量.md")), /ENOENT/);
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
      totals: { modules: 0, submodules: 0, cases: 0, assertions: 0, legacy: 0 },
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

test("更新步骤与断言同时写入资产和用例说明", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const cases = path.join(dataRoot, "ui", "cases");
  const caseMeta = {
    schema: "qa-ui-case/v1",
    caseId: "权限",
    project: { id: "pms", name: "项目管理系统" },
    page: "/pms/Contract",
    role: "管理员",
    dataPolicy: "read-only",
    tags: ["合同管理"],
    cases: [{
      name: "T1 列表可见",
      type: "functional",
      priority: "P2",
      steps: ["打开权限列表"],
      assertions: [{ id: "A1", kind: "business", text: "列表出现", source: "页面基线" }],
    }],
  };
  const assetPath = "ui/cases/权限.asset.json";
  await writeFile(path.join(cases, "权限.asset.json"), JSON.stringify({ caseId: "权限", caseMeta }, null, 2));
  await writeFile(path.join(cases, "权限.md"), [
    "# 权限",
    "",
    "```json qa-ui-case",
    JSON.stringify(caseMeta, null, 2),
    "```",
    "",
    "## 用例与断言",
    "",
    "| 用例 | 类型 | 优先级 | 断言 |",
    "| --- | --- | --- | --- |",
    "| T1 列表可见 | 功能 | P2 | A1 业务：列表出现（页面基线） |",
    "",
  ].join("\n"));

  const stepResult = await service.updateSteps(project.id, assetPath, "T1 列表可见", [
    "打开权限列表",
    "点击查询",
    "确认列表出现",
  ]);
  assert.deepEqual(stepResult.steps, ["打开权限列表", "点击查询", "确认列表出现"]);

  const result = await service.updateAssertions(project.id, assetPath, "T1 列表可见", [
    { id: "A1", kind: "business", text: "列表出现且总数正确", source: "需求声明" },
    { kind: "guard", text: "页面无报错", source: "页面基线" },
  ]);

  assert.equal(result.caseName, "T1 列表可见");
  assert.equal(result.assertions.length, 2);
  const asset = JSON.parse(await readFile(path.join(cases, "权限.asset.json"), "utf8"));
  assert.deepEqual(asset.caseMeta.cases[0].steps, ["打开权限列表", "点击查询", "确认列表出现"]);
  assert.deepEqual(asset.caseMeta.cases[0].assertions, [
    { id: "A1", kind: "business", text: "列表出现且总数正确", source: "需求声明" },
    { id: "A2", kind: "guard", text: "页面无报错", source: "页面基线" },
  ]);
  const document = await readFile(path.join(cases, "权限.md"), "utf8");
  assert.match(document, /列表出现且总数正确/);
  assert.match(document, /A2 前置：页面无报错（页面基线）/);
  assert.match(document, /确认列表出现/);
});

test("更新步骤/断言拒绝越界路径、非资产、未知用例和非法内容", async (t) => {
  const { service, project, dataRoot } = await setup(t);
  const cases = path.join(dataRoot, "ui", "cases");
  const caseMeta = {
    schema: "qa-ui-case/v1",
    caseId: "权限",
    project: { id: "pms", name: "项目管理系统" },
    page: "/pms/Contract",
    role: "管理员",
    dataPolicy: "read-only",
    tags: [],
    cases: [{
      name: "T1 列表可见",
      type: "functional",
      priority: "P2",
      steps: ["打开权限列表"],
      assertions: [{ id: "A1", kind: "business", text: "列表出现", source: "页面基线" }],
    }],
  };
  await writeFile(path.join(cases, "权限.asset.json"), JSON.stringify({ caseId: "权限", caseMeta }, null, 2));

  await assert.rejects(
    service.updateAssertions(project.id, "../权限.asset.json", "T1 列表可见", caseMeta.cases[0].assertions),
    /只能编辑 qa\/data\/ui\/cases/,
  );
  await assert.rejects(
    service.updateAssertions(project.id, "ui/cases/demo.md", "T1 列表可见", caseMeta.cases[0].assertions),
    /只能编辑 qa\/data\/ui\/cases/,
  );
  await assert.rejects(
    service.updateAssertions(project.id, "ui/cases/权限.asset.json", "不存在", caseMeta.cases[0].assertions),
    /未找到该用例/,
  );
  await assert.rejects(
    service.updateAssertions(project.id, "ui/cases/权限.asset.json", "T1 列表可见", []),
    /至少需要一条断言/,
  );
  await assert.rejects(
    service.updateAssertions(project.id, "ui/cases/权限.asset.json", "T1 列表可见", [
      { kind: "guard", text: "页面无报错", source: "页面基线" },
    ]),
    /至少需要一条业务断言/,
  );
  await assert.rejects(
    service.updateAssertions(project.id, "ui/cases/权限.asset.json", "T1 列表可见", [
      { kind: "business", text: "列表出现", source: "" },
    ]),
    /断言来源不能为空/,
  );
  await assert.rejects(
    service.updateSteps(project.id, "ui/cases/权限.asset.json", "T1 列表可见", []),
    /至少需要一个执行步骤/,
  );
  await assert.rejects(
    service.updateSteps(project.id, "ui/cases/权限.asset.json", "T1 列表可见", ["打开列表", ""]),
    /第 2 个执行步骤不能为空/,
  );
});
