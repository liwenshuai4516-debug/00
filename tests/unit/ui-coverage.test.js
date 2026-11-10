const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
async function write(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, JSON.stringify(value));
}

async function fixture(t) {
  const workspace = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-coverage-")));
  t.after(() => fs.rm(workspace, { recursive: true, force: true }));
  const { createReadOnlyWorkflow } = await import("../../src/main/capabilities/ui-testing/workflow.mjs");
  const api = createReadOnlyWorkflow({ ...resolveUiTestingRuntime({ isPackaged: false }, path.resolve(__dirname, "../..")), node: process.execPath });
  await write(path.join(workspace, "requirements.json"), { goal: "受控测试需求" });
  const roundId = "round-fixture";
  const roundDir = path.join(workspace, "qa/ui/rounds", roundId);
  const draft = { schema: "qa-ui-round/v1", roundId, projectId: "p", mode: "candidate", goal: "受控功能生成", budget: "最多 8 个任务",
    status: "active", stopReason: "", baseRevision: null, taskIds: [], features: [] };
  const feature = (featureId, inScope = true) => ({ featureId, name: featureId, modulePath: ["合同"], role: "reviewer", initialState: "固定数据", branch: "查询",
    confirmation: "pending", exploration: "pending", inScope, scopeReason: inScope ? "用户范围" : "自由发现仅探索",
    sources: [{ path: "requirements.json" }], checks: inScope ? [{ checkId: `${featureId}-check`, goal: "查询目标记录", reason: "等待探索" }] : [] });
  const save = async () => {
    await write(path.join(roundDir, "draft.json"), draft);
    const result = await api.coverage(workspace, { roundId, action: "save" });
    draft.baseRevision = result.revision;
    return result;
  };
  const task = async (taskId, overrides = {}) => {
    const contract = { mode: "candidate", role: "reviewer", initialState: "固定数据", dataStrategy: "read-only", cleanup: "none",
      expected: [{ id: "result", text: "目标记录可见", source: { kind: "user", reference: "受控需求" } }] };
    const record = { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", workspace, taskId, project: { id: "p", name: "项目" },
      targetUrl: "https://example.test/", status: "completed", terminal: { cleanupConfirmed: true }, startedAt: new Date().toISOString(), contract, ...overrides };
    const dir = path.join(workspace, "qa/ui/tasks", taskId);
    await write(path.join(dir, "task.json"), record);
    await fs.writeFile(path.join(dir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");
    return record;
  };
  const candidate = async (record, caseId) => {
    const dir = path.join(workspace, "qa/ui/tasks", record.taskId, "drafts", caseId);
    await fs.mkdir(dir, { recursive: true });
    await write(path.join(dir, "case.json"), { schema: "qa-ui-case/v1", taskId: record.taskId, caseId, project: record.project, targetUrl: record.targetUrl,
      role: record.contract.role, title: "查询记录", modulePath: ["合同"], initialState: record.contract.initialState, dataStrategy: "read-only", cleanup: "none",
      expected: record.contract.expected, steps: [{ stepId: "1", text: "查询" }], assertions: [{ kind: "business", expectedId: "result", text: "目标记录可见" }] });
    await fs.writeFile(path.join(dir, "case.spec.cjs"), 'const { test, expect } = require("@playwright/test");\ntest("fixture", async () => { expect(true).toBe(true); });\n// qa-initial-state qa-business-result\n');
    return api.saveCandidate(workspace, { taskId: record.taskId, caseId });
  };
  const confirm = (item, record) => {
    item.confirmation = "confirmed";
    item.exploration = "explored";
    item.sources = [{ taskId: record.taskId, path: `qa/ui/tasks/${record.taskId}/actions.jsonl` }];
    if (!draft.taskIds.includes(record.taskId)) draft.taskIds.push(record.taskId);
  };
  return { workspace, api, roundId, roundDir, draft, feature, save, task, candidate, confirm };
}

test("本轮生成率按功能去重，缺项和受阻项留存，修订及失败验证不冒充新增或通过", async (t) => {
  const f = await fixture(t);
  const a = f.feature("search");
  a.checks.push({ checkId: "search-empty", goal: "无结果查询", reason: "等待生成" }, { checkId: "search-reset", goal: "重置条件", reason: "缺少规则" });
  const b = f.feature("approval"); b.checks[0].reason = "已设计，自动化多角色能力受阻";
  const c = f.feature("free", false);
  const d = f.feature("pending");
  f.draft.features = [a, b, c, d];
  await f.save();
  const task = await f.task("task-new");
  for (const item of [a, b, c]) f.confirm(item, task);
  b.exploration = "blocked";
  const one = await f.candidate(task, "case-one");
  const two = await f.candidate(task, "case-two");
  a.checks[0].case = { caseId: one.caseId, revision: one.revision }; a.checks[0].expectedIds = ["result"];
  a.checks[1].case = { caseId: two.caseId, revision: two.revision }; a.checks[1].expectedIds = ["result"];
  const result = await f.save();
  assert.deepEqual(result.counts, { features: 4, confirmedFeatures: 3, pendingFeatures: 1, eligibleFeatures: 2, generatedFeatures: 1,
    conversionRate: 50, pendingInScope: 1, outOfScopeFeatures: 1, generatedCases: 2, reusedCases: 0, plannedChecks: 5, checksWithCandidate: 2, missingChecks: 3 });
  const patched = await f.candidate(task, "case-one");
  a.checks[0].case.revision = patched.revision;
  const assetPath = path.join(f.workspace, "qa/ui/cases/case-one/asset.json");
  const asset = await read(assetPath);
  asset.revisions[1].validationRunId = "run-failed";
  await write(assetPath, asset);
  await write(path.join(f.workspace, "qa/ui/runs/run-failed/summary.json"), { workflow: "browser-use-playwright", purpose: "validate", workspace: f.workspace,
    project: { id: "p" }, runId: "run-failed", revisions: { "case-one": "0002" }, sourceTaskIds: { "case-one": task.taskId }, status: "failed" });
  f.draft.status = "partial"; f.draft.stopReason = "总预算耗尽，保留待确认与受阻项";
  const final = await f.save();
  assert.deepEqual(final.counts, result.counts);
  const snapshot = await read(final.summaryFile);
  assert.equal(snapshot.mappings[0].validationStatus, "failed");
  assert.equal(snapshot.mappings[0].published, false);
  const document = await fs.readFile(final.summaryDocument, "utf8");
  assert.match(document, /缺少规则/); assert.match(document, /多角色能力受阻/); assert.match(document, /50%/);
  await fs.rm(path.join(f.roundDir, "draft.json"));
  await fs.rm(path.join(f.workspace, "qa/ui/cases"), { recursive: true });
  const historical = await f.api.coverage(f.workspace, { roundId: f.roundId, action: "read", revision: "0002" });
  assert.deepEqual(historical.counts, result.counts, "历史统计不受后续删除、修订或运行影响");
  await assert.rejects(f.save(), /已经收尾/);
});

test("零分母、纯探索和未保存清单分别处理，不伪造百分比", async (t) => {
  const f = await fixture(t);
  await assert.rejects(f.api.coverage(f.workspace, { roundId: f.roundId, action: "read" }));
  f.draft.mode = "explore";
  f.draft.features = [f.feature("discover", false)];
  const result = await f.save();
  assert.equal(result.counts.conversionRate, null);
  assert.match(await fs.readFile(result.summaryDocument, "utf8"), /不适用/);
  f.draft.features[0].inScope = true;
  await assert.rejects(f.save(), /纯探索/);
});

test("历史候选复用单列，不计为本轮生成", async (t) => {
  const f = await fixture(t);
  const old = await f.task("task-old", { startedAt: "2020-01-01T00:00:00.000Z" });
  const selected = await f.candidate(old, "case-old");
  f.draft.features = [f.feature("reuse")];
  await f.save();
  const discovered = await f.task("task-discovery");
  f.confirm(f.draft.features[0], discovered);
  f.draft.features[0].checks[0].case = { caseId: selected.caseId, revision: selected.revision };
  f.draft.features[0].checks[0].expectedIds = ["result"];
  const result = await f.save();
  assert.equal(result.counts.generatedCases, 0);
  assert.equal(result.counts.generatedFeatures, 0);
  assert.equal(result.counts.reusedCases, 1);
  assert.equal(result.counts.checksWithCandidate, 1);
  assert.equal(result.counts.conversionRate, 0);
});

test("拒绝移除分母、丢失检查项、过期保存及无依据映射，失败保留上一版本", async (t) => {
  const f = await fixture(t);
  const item = f.feature("search");
  f.draft.features = [item];
  await f.save();
  const record = await f.task("task-discovery");
  f.confirm(item, record);
  const selected = await f.candidate(record, "case-good");
  item.checks[0].case = { caseId: selected.caseId, revision: selected.revision };
  item.checks[0].expectedIds = ["result"];
  await f.save();
  const valid = structuredClone(f.draft);
  const invalid = [
    [(draft) => { draft.features = []; }, /删除功能/],
    [(draft) => { draft.features[0].inScope = false; }, /移出分母/],
    [(draft) => { draft.features[0].checks = []; }, /检查目标/],
    [(draft) => { draft.baseRevision = "0001"; }, /版本已变化/],
    [(draft) => { draft.features[0].checks[0].expectedIds = ["invented"]; }, /业务预期引用/],
    [(draft) => { draft.features[0].checks.push({ ...draft.features[0].checks[0], checkId: "duplicate" }); }, /多个独立检查项/],
    [(draft) => { draft.features[0].sources[0].path = "../outside"; }, /相对路径/],
    [(draft) => { draft.features[0].sources[0].path = "qa/ui/tasks/task-other/actions.jsonl"; }, /ENOENT/],
  ];
  for (const [mutate, expected] of invalid) {
    const draft = structuredClone(valid); mutate(draft);
    await write(path.join(f.roundDir, "draft.json"), draft);
    await assert.rejects(f.api.coverage(f.workspace, { roundId: f.roundId, action: "save" }), expected);
  }
  assert.equal((await f.api.coverage(f.workspace, { roundId: f.roundId, action: "read" })).revision, "0002");
  const assetPath = path.join(f.workspace, "qa/ui/cases/case-good/asset.json");
  const asset = await read(assetPath); asset.origin = "manual";
  await write(assetPath, asset);
  await write(path.join(f.roundDir, "draft.json"), valid);
  await assert.rejects(f.api.coverage(f.workspace, { roundId: f.roundId, action: "save" }), /手动设计稿/);
});

test("失败发现不可升级确认，项目归属、链接、取消和共享锁保持边界", async (t) => {
  const f = await fixture(t);
  const item = f.feature("blocked"); f.draft.features = [item];
  await f.save();
  const record = await f.task("task-failed", { status: "failed", terminal: { cleanupConfirmed: false } });
  f.confirm(item, record);
  await assert.rejects(f.save(), /成功且清理确认/);
  item.confirmation = "pending"; item.exploration = "blocked";
  assert.equal((await f.save()).counts.pendingInScope, 1);
  const foreign = await f.task("task-foreign", { project: { id: "other" } });
  f.draft.taskIds.push(foreign.taskId);
  await assert.rejects(f.save(), /不属于当前项目/);
  f.draft.taskIds.pop();
  const link = path.join(f.workspace, "linked.json");
  await fs.symlink(path.join(f.workspace, "requirements.json"), link);
  item.sources = [{ path: "linked.json" }];
  await assert.rejects(f.save(), /链接/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.api.coverage(f.workspace, { roundId: f.roundId, action: "read" }, controller.signal), /abort/i);
  const lock = path.join(f.workspace, "qa/ui/.workflow.lock");
  await fs.writeFile(lock, "unknown");
  await assert.rejects(f.api.coverage(f.workspace, { roundId: f.roundId, action: "read" }), /未收尾/);
  assert.equal(await fs.readFile(lock, "utf8"), "unknown");
});

test("验证结果尚缺不抹掉已生成候选，损坏的候选哈希和错误映射仍拒绝保存", async (t) => {
  const f = await fixture(t);
  const item = f.feature("search"); f.draft.features = [item];
  await f.save();
  const record = await f.task("task-new"); f.confirm(item, record);
  const selected = await f.candidate(record, "case-pending");
  item.checks[0].case = { caseId: selected.caseId, revision: selected.revision }; item.checks[0].expectedIds = ["invented"];
  await assert.rejects(f.save(), /业务预期及断言/);
  item.checks[0].expectedIds = ["result"];
  const assetPath = path.join(f.workspace, "qa/ui/cases/case-pending/asset.json");
  const asset = await read(assetPath); asset.revisions[0].validationRunId = "run-pending";
  await write(assetPath, asset);
  const result = await f.save();
  assert.equal(result.counts.conversionRate, 100);
  const snapshot = await read(result.summaryFile);
  assert.equal(snapshot.mappings[0].validationStatus, "unknown");
  assert.equal(snapshot.mappings[0].published, false);
  await fs.appendFile(path.join(f.workspace, "qa/ui/cases/case-pending/revisions/0001/case.spec.cjs"), "// tampered\n");
  await assert.rejects(f.save(), /文件已变更/);
});

test("并发保存不能覆盖旧版本，未完成的快照不会当成成功恢复", async (t) => {
  const f = await fixture(t);
  await f.save();
  await write(path.join(f.roundDir, "draft.json"), f.draft);
  const results = await Promise.allSettled([1, 2].map(() => f.api.coverage(f.workspace, { roundId: f.roundId, action: "save" })));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  await fs.mkdir(path.join(f.roundDir, "0003"));
  await assert.rejects(f.api.coverage(f.workspace, { roundId: f.roundId, action: "read" }), /ENOENT/);
  assert.equal((await f.api.coverage(f.workspace, { roundId: f.roundId, action: "read", revision: "0001" })).revision, "0001");
});
