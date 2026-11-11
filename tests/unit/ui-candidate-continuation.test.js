const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { createHash } = require("node:crypto");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value));
const digest = data => createHash("sha256").update(data).digest("hex");

async function fixture(t) {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-continuation-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留候选承接现场：${base}\n`));
  const { createReadOnlyWorkflow } = await import("../../src/main/capabilities/ui-testing/workflow.mjs");
  const api = createReadOnlyWorkflow({ ...resolveUiTestingRuntime({ isPackaged: false }, path.resolve(__dirname, "../..")), node: process.execPath });
  const taskId = "task-source";
  const caseId = "case-source";
  const dir = path.join(base, "qa/ui/tasks", taskId);
  const draft = path.join(dir, "drafts", caseId);
  await fs.mkdir(draft, { recursive: true });
  const contract = { mode: "candidate", goal: "查看受控结果", role: "reviewer", initialState: "受控初态",
    identity: { selector: "#identity", text: "reviewer" }, dataStrategy: "read-only", cleanup: "none",
    expected: [{ id: "result", text: "Beta", source: { kind: "user", reference: "受控需求" } }] };
  const task = { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId, workspace: base,
    project: { id: "p", name: "Fixture", address: "https://example.invalid" }, targetUrl: "https://example.invalid/",
    contract, status: "completed", terminal: { cleanupConfirmed: true }, startedAt: "2020-01-01T00:00:00.000Z" };
  const taskFile = path.join(dir, "task.json");
  const actionsFile = path.join(dir, "actions.jsonl");
  await write(taskFile, task);
  await fs.writeFile(actionsFile, JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");
  const meta = { schema: "qa-ui-case/v1", taskId, caseId, project: task.project, targetUrl: task.targetUrl,
    title: "结果一致", modulePath: ["Fixture"], role: contract.role, initialState: contract.initialState,
    dataStrategy: "read-only", cleanup: "none", expected: contract.expected,
    steps: [{ stepId: "1", text: "查看结果" }], assertions: [{ kind: "business", expectedId: "result", text: "Beta" }] };
  await write(path.join(draft, "case.json"), meta);
  await fs.writeFile(path.join(draft, "case.spec.cjs"), 'const { test, expect } = require("@playwright/test");\ntest("result", async () => { expect("Beta").toBe("Beta"); });\n// qa-initial-state qa-business-result\n');
  const original = await api.saveCandidate(base, { taskId, caseId });
  const continueCase = () => api.saveCandidate(base, { operation: "continue-candidate", caseId, baseRevision: original.revision });
  const assetFile = path.join(base, "qa/ui/cases", caseId, "asset.json");
  const originalMeta = path.join(base, "qa/ui/cases", caseId, "revisions/0001/case.json");
  return { base, api, task, taskFile, actionsFile, assetFile, originalMeta, meta, caseId, taskId, continueCase,
    pass: () => { passed = true; } };
}

test("候选显式承接：旧门禁、幂等、来源不变、字段冻结及全资产预算", async t => {
  const f = await fixture(t);
  await assert.rejects(f.api.run(f.base, { caseId: f.caseId, revision: "0001", mode: "validate" }), /候选/);
  await assert.rejects(f.api.saveCandidate(f.base, { caseId: f.caseId, baseRevision: "0001", parentRunId: "run-failed" }), /正式版本/);
  await assert.rejects(f.api.saveCandidate(f.base, { operation: "continue-candidate", taskId: f.taskId, caseId: f.caseId, baseRevision: "0001" }), /混用/);
  const original = await Promise.all([f.taskFile, f.actionsFile, f.originalMeta].map(file => fs.readFile(file)));
  const continuation = await f.continueCase();
  assert.equal(continuation.sourceTaskId, f.taskId);
  assert.equal((await f.continueCase()).taskId, continuation.taskId);
  assert.equal((await fs.readdir(path.join(f.base, "qa/ui/tasks"))).length, 2);
  const owner = await read(path.join(f.base, "qa/ui/tasks", continuation.taskId, "task.json"));
  assert.equal(owner.kind, "candidate-continuation");
  assert.equal(owner.contract.mode, "complete");
  await assert.rejects(fs.access(path.join(f.base, "qa/ui/tasks", continuation.taskId, "actions.jsonl")), /ENOENT/);
  const metaFile = path.join(continuation.draftDirectory, "case.json");
  const meta = await read(metaFile);
  assert.equal(meta.taskId, continuation.taskId);
  for (const [key, value] of [["expected", []], ["steps", []], ["assertions", []], ["initialState", "其他初态"], ["role", "admin"]]) {
    await write(metaFile, { ...meta, [key]: value });
    await assert.rejects(f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId }), /不能改变|一致|预期|约定/);
  }
  await write(metaFile, meta);
  const saved = await f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId });
  assert.equal(saved.revision, "0002");
  assert.equal((await f.continueCase()).taskId, continuation.taskId, "保存新修订后仍返回已有承接任务");
  await assert.rejects(f.api.run(f.base, { caseId: f.caseId, revision: "0002", mode: "regression" }), /正式版本/);
  assert.equal((await f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId })).revision, "0003");
  await assert.rejects(f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId }), /预算/);
  const current = await Promise.all([f.taskFile, f.actionsFile, f.originalMeta].map(file => fs.readFile(file)));
  current.forEach((bytes, index) => assert.deepEqual(bytes, original[index]));
  assert.equal((await read(f.assetFile)).currentRevision, null);
  f.pass();
});

test("承接版本的覆盖追溯原探索，不能计为新探索；源证据变化拒绝保存和执行", async t => {
  const f = await fixture(t);
  const continuation = await f.continueCase();
  const saved = await f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId });
  const roundDir = path.join(f.base, "qa/ui/rounds/round-new");
  await fs.mkdir(roundDir, { recursive: true });
  await write(path.join(roundDir, "draft.json"), { schema: "qa-ui-round/v1", roundId: "round-new", projectId: "p",
    mode: "complete", goal: "复用旧候选验证", budget: "一个候选", status: "partial", stopReason: "仅验证追溯", baseRevision: null,
    taskIds: [f.taskId, continuation.taskId], features: [{ featureId: "view", name: "查看", modulePath: ["Fixture"],
      role: "reviewer", initialState: "受控初态", branch: "查看", scopeReason: "用户范围", confirmation: "confirmed", exploration: "explored", inScope: true,
      sources: [{ taskId: f.taskId, path: `qa/ui/tasks/${f.taskId}/actions.jsonl` }],
      checks: [{ checkId: "view-result", goal: "结果一致", case: { caseId: f.caseId, revision: saved.revision }, expectedIds: ["result"] }] }] });
  const coverage = await f.api.coverage(f.base, { action: "save", roundId: "round-new" });
  const snapshot = await read(coverage.summaryFile);
  assert.equal(snapshot.counts.generatedCases, 0);
  assert.equal(snapshot.counts.reusedCases, 1);
  assert.equal(snapshot.mappings[0].sourceTaskId, f.taskId);
  assert.equal(snapshot.mappings[0].taskId, continuation.taskId);
  await fs.appendFile(f.actionsFile, "\n");
  await assert.rejects(f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId }), /来源版本或探索证据已变化/);
  await assert.rejects(f.api.run(f.base, { caseId: f.caseId, revision: "0002", mode: "validate" }), /来源版本或探索证据已变化/);
  assert.equal((await read(f.assetFile)).revisions[1].validationRunId, undefined, "来源校验失败不消耗验证批次");
  f.pass();
});

test("源任务清理未知、隔离写、审批计划、哈希异常和工作区锁不得承接", async t => {
  const f = await fixture(t);
  for (const task of [{ ...f.task, terminal: { cleanupConfirmed: false } },
    { ...f.task, contract: { ...f.task.contract, dataStrategy: "isolated-write" } },
    { ...f.task, approvalPlan: { actors: [] } }]) {
    await write(f.taskFile, task);
    await assert.rejects(f.continueCase(), /收尾|只读/);
  }
  await write(f.taskFile, f.task);
  const bytes = await fs.readFile(f.originalMeta);
  await fs.appendFile(f.originalMeta, "\n");
  await assert.rejects(f.continueCase(), /文件已变更/);
  await fs.writeFile(f.originalMeta, bytes);
  const lock = path.join(f.base, "qa/ui/.workflow.lock");
  await fs.writeFile(lock, "");
  await assert.rejects(f.continueCase(), /未收尾/);
  await fs.unlink(lock);
  const asset = await read(f.assetFile);
  asset.revisions[0].validationRunId = "run-old";
  await write(f.assetFile, asset);
  await assert.rejects(f.continueCase(), /未验证候选/);
  asset.revisions[0].validationRunId = null;
  await write(f.assetFile, asset);
  await fs.rename(f.actionsFile, f.actionsFile + ".saved");
  await fs.symlink(f.actionsFile + ".saved", f.actionsFile);
  await assert.rejects(f.continueCase(), /符号链接/);
  assert.equal(digest(await fs.readFile(f.originalMeta)), asset.revisions[0].hashes["case.json"]);
  f.pass();
});

test("承接版本发布后修复，覆盖仍回溯原探索而非承接或修复时间", async t => {
  const f = await fixture(t);
  const continuation = await f.continueCase();
  const saved = await f.api.saveCandidate(f.base, { taskId: continuation.taskId, caseId: f.caseId });
  // 此夹具只验证来源关联；真实浏览器验证/发布另由 SDK 集成检查承担。
  const asset = await read(f.assetFile);
  asset.currentRevision = saved.revision;
  asset.revisions[1].validatedRunId = "run-validation";
  await write(f.assetFile, asset);
  const parentRunId = "run-regression-failed";
  const runDir = path.join(f.base, "qa/ui/runs", parentRunId);
  await fs.mkdir(runDir, { recursive: true });
  const parent = { runId: parentRunId, workflow: "browser-use-playwright", workspace: f.base,
    purpose: "regression", schema: "qa-report/v1", kind: "ui", project: f.task.project,
    status: "failed", caseIds: [f.caseId], revisions: { [f.caseId]: saved.revision } };
  await write(path.join(runDir, "summary.json"), parent);
  await write(path.join(runDir, "task.json"), parent);
  const repair = await f.api.saveCandidate(f.base, { caseId: f.caseId, baseRevision: saved.revision, parentRunId });
  for (const name of ["case.json", "case.spec.cjs"]) {
    await fs.copyFile(path.join(continuation.draftDirectory, name), path.join(repair.draftDirectory, name));
  }
  const patch = await f.api.saveCandidate(f.base, { caseId: f.caseId, taskId: repair.taskId });
  const roundId = "round-repaired";
  const roundDir = path.join(f.base, "qa/ui/rounds", roundId);
  await fs.mkdir(roundDir, { recursive: true });
  await write(path.join(roundDir, "draft.json"), { schema: "qa-ui-round/v1", roundId, projectId: "p",
    mode: "complete", goal: "已发布承接版本的修复来源", budget: "一个修复版本", status: "partial", stopReason: "来源关联检查", baseRevision: null,
    taskIds: [f.taskId, continuation.taskId, repair.taskId], features: [{ featureId: "view", name: "查看", modulePath: ["Fixture"],
      role: "reviewer", initialState: "受控初态", branch: "查看", scopeReason: "用户范围", confirmation: "confirmed", exploration: "explored", inScope: true,
      sources: [{ taskId: f.taskId, path: `qa/ui/tasks/${f.taskId}/actions.jsonl` }],
      checks: [{ checkId: "view-result", goal: "结果一致", case: { caseId: f.caseId, revision: patch.revision }, expectedIds: ["result"] }] }] });
  const coverage = await f.api.coverage(f.base, { action: "save", roundId });
  const snapshot = await read(coverage.summaryFile);
  assert.equal(snapshot.mappings[0].taskId, repair.taskId);
  assert.equal(snapshot.mappings[0].sourceTaskId, f.taskId);
  assert.equal(snapshot.counts.reusedCases, 1);
  assert.equal(snapshot.counts.generatedCases, 0);
  await fs.appendFile(f.actionsFile, "\n");
  await assert.rejects(f.api.run(f.base, { caseId: f.caseId, revision: patch.revision, mode: "validate" }), /来源版本或探索证据已变化/);
  f.pass();
});
