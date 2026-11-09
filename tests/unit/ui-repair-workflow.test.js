const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const http = require("node:http");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const { createHash } = require("node:crypto");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

const repo = path.resolve(__dirname, "../..");
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data));

// 已有用例修复：只读用例、有证据的失败回归、原 revision 与父批次校验、两个补丁预算、发布与关联。
test("修复任务：父批次校验、补丁预算、预期与步骤冻结、发布关联", { timeout: 120000 }, async (t) => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers, runtime.browserPython].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的内置 Chromium、Node 与 browser-use 运行时。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-ui-repair-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留修复检查现场：${base}\n`));
  const workspace = path.join(base, "工作区 ' repair");
  await fs.mkdir(workspace);
  let mode = "pass";
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    const field = mode === "relabel" ? "outcome" : "result";
    res.end(`<p data-testid="identity">reviewer</p><p data-testid="${field}">${mode === "wrong" ? "Wrong" : "Beta"}</p>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const config = path.join(base, "projects.json");
  await write(config, { projects: [{ id: "p", name: "Fixture", workspaceDir: workspace, address: url }] });

  const { createReadOnlyWorkflow } = await import(pathToFileURL(path.join(repo, "src/main/capabilities/ui-testing/workflow.mjs")).href);
  const api = createReadOnlyWorkflow({ ...runtime, projectConfig: config });
  const caseId = "repair-case";
  const taskId = "task-fixture";
  const taskDir = path.join(workspace, "qa/ui/tasks", taskId);
  await fs.mkdir(path.join(taskDir, "drafts"), { recursive: true });
  const contract = { mode: "complete", goal: "核对结果文本", role: "reviewer",
    identity: { selector: '[data-testid="identity"]', text: "reviewer" },
    initialState: "受控页面固定 Beta", dataStrategy: "read-only", cleanup: "none",
    expected: [{ id: "result", text: "结果为 Beta", source: { kind: "user", reference: "修复夹具" } }] };
  await write(path.join(taskDir, "task.json"), { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId, workspace, status: "completed",
    project: { id: "p", name: "Fixture", address: url }, targetUrl: url, contract });
  await fs.writeFile(path.join(taskDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");

  const draft = path.join(taskDir, "drafts", caseId);
  await fs.mkdir(draft);
  const spec = (field) => `const { test, expect } = require("@playwright/test");
test("结果一致", async ({ page }, testInfo) => {
  await page.goto(process.env.QA_TARGET_URL);
  await expect(page.getByTestId("identity")).toHaveText("reviewer");
  const initial = testInfo.outputPath("initial.png");
  await page.screenshot({ path: initial });
  await testInfo.attach("qa-initial-state", { path: initial, contentType: "image/png" });
  await expect(page.getByTestId("${field}")).toHaveText("Beta", { timeout: 2000 });
  const business = testInfo.outputPath("business.png");
  await page.screenshot({ path: business });
  await testInfo.attach("qa-business-result", { path: business, contentType: "image/png" });
});\n`;
  const metadata = { schema: "qa-ui-case/v1", caseId, taskId, project: { id: "p", name: "Fixture" },
    title: "结果一致", modulePath: ["Fixture"], targetUrl: url, role: "reviewer",
    initialState: contract.initialState, dataStrategy: "read-only", cleanup: "none", expected: contract.expected,
    steps: [{ stepId: "1", text: "核对结果" }], assertions: [{ kind: "business", expectedId: "result", text: "结果为 Beta" }] };
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec("result"));
  await write(path.join(draft, "case.json"), metadata);
  const candidate = await api.saveCandidate(workspace, { taskId, caseId });
  const validation = await api.run(workspace, { caseId, revision: candidate.revision, mode: "validate" });
  assert.equal(validation.status, "passed");
  await api.publish(workspace, { caseId, revision: candidate.revision, runId: validation.runId });

  // 页面字段改名造成定位失败；业务预期不变。
  mode = "relabel";
  const failed = await api.regress(workspace, { projectId: "p", caseIds: [caseId] });
  assert.equal(failed.status, "failed");
  const failedSummary = await read(failed.summaryFile);
  assert.equal(failedSummary.purpose, "regression");
  assert.equal(failedSummary.status, "failed");

  // 父批次必须是该正式版本真实失败的 regression。
  await assert.rejects(api.saveCandidate(workspace, { caseId, baseRevision: candidate.revision, parentRunId: validation.runId }), /失败/);
  await assert.rejects(api.saveCandidate(workspace, { caseId, baseRevision: "0009", parentRunId: failed.runId }), /未登记/);
  await assert.rejects(api.saveCandidate(workspace, { caseId: "other-case", baseRevision: candidate.revision, parentRunId: failed.runId }), /不存在|ENOENT/);

  const repair = await api.saveCandidate(workspace, { caseId, baseRevision: candidate.revision, parentRunId: failed.runId });
  assert.equal(repair.status, "repair-task");
  assert.ok(repair.taskId.startsWith("task-"));
  const repairTask = await read(path.join(workspace, "qa/ui/tasks", repair.taskId, "task.json"));
  assert.equal(repairTask.kind, "repair");
  assert.equal(repairTask.repair.parentRunId, failed.runId);
  assert.equal(repairTask.repair.baseRevision, candidate.revision);
  assert.deepEqual(repairTask.contract.expected, contract.expected);
  assert.equal(existsSync(path.join(workspace, "qa/ui/tasks", repair.taskId, "actions.jsonl")), false, "修复任务不启动探索也不产生动作记录");

  // 同一失败批次不能重复建立任务，避免重置补丁预算。
  await assert.rejects(api.saveCandidate(workspace, { caseId, baseRevision: candidate.revision, parentRunId: failed.runId }), /已建立修复任务/);

  const repairDraft = repair.draftDirectory;
  const baseMeta = await read(path.join(workspace, "qa/ui/cases", caseId, "revisions/0001/case.json"));
  const tampered = (mutate) => { const value = structuredClone(baseMeta); mutate(value); return value; };
  await fs.writeFile(path.join(repairDraft, "case.spec.cjs"), spec("outcome"));
  await write(path.join(repairDraft, "case.json"), tampered((value) => { value.expected[0].text = "改成别的"; }));
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId }), /预期/);
  await write(path.join(repairDraft, "case.json"), tampered((value) => { value.steps[0].stepId = "9"; }));
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId }), /不能改变 steps/);
  await write(path.join(repairDraft, "case.json"), tampered((value) => { value.assertions[0].text = "改断言"; }));
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId }), /不能改变 assertions/);
  await write(path.join(repairDraft, "case.json"), tampered((value) => { value.title = "改标题"; }));
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId }), /不能改变 title/);
  await write(path.join(repairDraft, "case.json"), tampered((value) => { value.taskId = repair.taskId; }));
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId }), /原探索任务编号/);
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId: "unknown" }), /不匹配/);

  // 只改脚本定位，业务说明原样保留；最多两个补丁。
  await write(path.join(repairDraft, "case.json"), baseMeta);
  const first = await api.saveCandidate(workspace, { taskId: repair.taskId, caseId, patchSummary: "修正结果定位器" });
  assert.equal(first.revision, "0002");
  const second = await api.saveCandidate(workspace, { taskId: repair.taskId, caseId, patchSummary: "第二个补丁" });
  assert.equal(second.revision, "0003");
  await assert.rejects(api.saveCandidate(workspace, { taskId: repair.taskId, caseId, patchSummary: "第三个补丁" }), /最多两个/);
  const assetAfterPatches = await read(path.join(workspace, "qa/ui/cases", caseId, "asset.json"));
  const patchEntry = assetAfterPatches.revisions.find((item) => item.revision === "0002");
  assert.equal(patchEntry.baseRevision, "0001");
  assert.equal(patchEntry.baseTaskId, taskId);
  assert.equal(patchEntry.parentRunId, failed.runId);
  assert.equal(patchEntry.patchSummary, "修正结果定位器");
  assert.equal(patchEntry.taskId, repair.taskId);

  const repaired = await api.run(workspace, { caseId, revision: "0002", mode: "validate" });
  assert.equal(repaired.status, "passed", JSON.stringify((await read(repaired.summaryFile)).problems));
  const repairedSummary = await read(repaired.summaryFile);
  assert.equal(repairedSummary.parentRunId, failed.runId);
  assert.equal(repairedSummary.patchSummary, "修正结果定位器");
  assert.deepEqual(repairedSummary.sourceTaskIds, { [caseId]: repair.taskId });
  assert.equal(repairedSummary.revisions[caseId], "0002");
  const published = await api.publish(workspace, { caseId, revision: "0002", runId: repaired.runId });
  assert.equal(published.status, "verified");
  const asset = await read(path.join(workspace, "qa/ui/cases", caseId, "asset.json"));
  assert.equal(asset.currentRevision, "0002");

  // 历史失败报告保留；父批次仍被修复任务引用时不能删除。
  const after = await read(failed.summaryFile);
  assert.equal(after.status, "failed");
  const { removeUiReport, removeUiCase } = await import(pathToFileURL(path.join(repo, "src/main/capabilities/ui-testing/workflow.mjs")).href);
  await assert.rejects(removeUiReport(workspace, { projectId: "p", runId: failed.runId }), /修复任务/);

  const regression = await api.regress(workspace, { projectId: "p", caseIds: [caseId] });
  assert.equal(regression.status, "passed");
  await assert.rejects(api.saveCandidate(workspace, { caseId, baseRevision: "0001", parentRunId: failed.runId }), /当前正式版本/);

  // 删除用例时修复版本说明仍能按原探索任务编号校验通过。
  const assetBytes = await fs.readFile(path.join(workspace, "qa/ui/cases", caseId, "asset.json"));
  const removed = await removeUiCase(workspace, { projectId: "p", caseId, assetHash: createHash("sha256").update(assetBytes).digest("hex") });
  assert.equal(removed.caseId, caseId);

  passed = true;
});
