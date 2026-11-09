const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const http = require("node:http");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

const repo = path.resolve(__dirname, "../..");
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data));

// 已声明残留：无法清理的测试环境需单独残留授权与 qa-residue 证据，不能静默跳过清理。
test("声明残留的隔离写：残留授权、证据与发布", { timeout: 120000 }, async (t) => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的内置 Chromium 与 Node 环境。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-ui-residual-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留残留声明检查现场：${base}\n`));
  const workspace = path.join(base, "工作区 ' residual");
  await fs.mkdir(workspace);
  const server = http.createServer((req, res) => {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en"><body>
<p data-testid="identity">reviewer</p>
<label>Name<input aria-label="Name"></label>
<button type="button">Create</button><ul id="list"></ul>
<script>
const list = document.getElementById("list"); const input = document.querySelector("input");
document.querySelector("button").onclick = () => {
  if (!input.value) return;
  const row = document.createElement("li"); row.textContent = input.value;
  list.append(row); input.value = "";
};
</script></body></html>`);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const config = path.join(base, "projects.json");
  await write(config, { projects: [{ id: "p", name: "Fixture", workspaceDir: workspace, address: url }] });

  const { createReadOnlyWorkflow } = await import(pathToFileURL(path.join(repo, "src/main/capabilities/ui-testing/workflow.mjs")).href);
  const api = createReadOnlyWorkflow({ ...runtime, projectConfig: config });
  const caseId = "residual-case";
  const taskId = "task-residual";
  const taskDir = path.join(workspace, "qa/ui/tasks", taskId);
  await fs.mkdir(path.join(taskDir, "drafts"), { recursive: true });
  const writeAuthorization = { kind: "user", reference: "受控写夹具允许创建测试数据" };
  const residualAuthorization = { kind: "user", reference: "测试环境无法删除，明确接受本次残留" };
  const contract = { mode: "complete", goal: "创建唯一测试数据并声明残留", role: "reviewer",
    identity: { selector: '[data-testid="identity"]', text: "reviewer" },
    initialState: "受控页面无历史数据；每轮创建独立对象", dataStrategy: "isolated-write", cleanup: "residual",
    writeAuthorization, residualAuthorization,
    expected: [{ id: "created", text: "本次创建的数据可见", source: { kind: "user", reference: "受控写夹具" } }] };
  await write(path.join(taskDir, "task.json"), { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId, workspace, status: "completed",
    project: { id: "p", name: "Fixture", address: url }, targetUrl: url, contract });
  await fs.writeFile(path.join(taskDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");
  const draft = path.join(taskDir, "drafts", caseId);
  await fs.mkdir(draft);
  const spec = `const { test, expect } = require("@playwright/test");
test("残留声明创建", async ({ page }, testInfo) => {
  await page.goto(process.env.QA_TARGET_URL);
  await expect(page.getByTestId("identity")).toHaveText("reviewer");
  const name = \`qa-\${process.env.QA_RUN_ID}\`;
  const initial = testInfo.outputPath("initial.png");
  await page.screenshot({ path: initial });
  await testInfo.attach("qa-initial-state", { path: initial, contentType: "image/png" });
  await page.getByRole("textbox", { name: "Name" }).fill(name);
  await page.getByRole("button", { name: "Create" }).click();
  const row = page.getByRole("listitem").filter({ hasText: name });
  await expect(row).toHaveCount(1);
  const business = testInfo.outputPath("business.png");
  await page.screenshot({ path: business });
  await testInfo.attach("qa-business-result", { path: business, contentType: "image/png" });
  const residue = testInfo.outputPath("residue.png");
  await page.screenshot({ path: residue });
  await testInfo.attach("qa-residue", { path: residue, contentType: "image/png" });
});\n`;
  const metadata = { schema: "qa-ui-case/v1", caseId, taskId, project: { id: "p", name: "Fixture" },
    title: "残留声明创建", modulePath: ["Fixture"], targetUrl: url, role: "reviewer",
    initialState: contract.initialState, dataStrategy: "isolated-write", cleanup: "residual",
    writeAuthorization, residualAuthorization,
    expected: contract.expected, steps: [{ stepId: "1", text: "创建本次数据" }],
    assertions: [{ kind: "business", expectedId: "created", text: "本次数据可见" }] };
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec);
  await write(path.join(draft, "case.json"), metadata);

  // 缺 qa-residue 或残留授权不一致时不能保存。
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec.replaceAll("qa-residue", "residue-evidence"));
  await assert.rejects(api.saveCandidate(workspace, { taskId, caseId }), /qa-residue/);
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec);
  await write(path.join(draft, "case.json"), { ...metadata, residualAuthorization: { kind: "rule", reference: "其他来源" } });
  await assert.rejects(api.saveCandidate(workspace, { taskId, caseId }), /残留授权/);
  await write(path.join(draft, "case.json"), metadata);

  const candidate = await api.saveCandidate(workspace, { taskId, caseId });
  const validation = await api.run(workspace, { caseId, revision: candidate.revision, mode: "validate" });
  assert.equal(validation.status, "passed", JSON.stringify((await read(validation.summaryFile)).problems));
  const summary = await read(validation.summaryFile);
  assert.equal(summary.dataStrategy, "isolated-write");
  assert.equal(summary.dataCleanup, "residual");
  assert.deepEqual(summary.writeAuthorization, writeAuthorization);
  assert.deepEqual(summary.residualAuthorization, residualAuthorization);
  const published = await api.publish(workspace, { caseId, revision: candidate.revision, runId: validation.runId });
  assert.equal(published.status, "verified");

  // 任务缺少残留授权时，执行阶段直接拒绝，不会静默按普通清理处理。
  const unsafeDir = path.join(workspace, "qa/ui/tasks", "task-unsafe");
  const unsafeCase = "unsafe-case";
  await fs.mkdir(path.join(unsafeDir, "drafts", unsafeCase), { recursive: true });
  await write(path.join(unsafeDir, "task.json"), { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId: "task-unsafe", workspace,
    status: "completed", project: { id: "p", name: "Fixture", address: url }, targetUrl: url,
    contract: { ...contract, residualAuthorization: undefined } });
  await fs.writeFile(path.join(unsafeDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");
  await fs.writeFile(path.join(unsafeDir, "drafts", unsafeCase, "case.spec.cjs"), spec);
  await write(path.join(unsafeDir, "drafts", unsafeCase, "case.json"),
    { ...metadata, caseId: unsafeCase, taskId: "task-unsafe", residualAuthorization: undefined });
  const unsafeCandidate = await api.saveCandidate(workspace, { taskId: "task-unsafe", caseId: unsafeCase });
  await assert.rejects(api.run(workspace, { caseId: unsafeCase, revision: unsafeCandidate.revision, mode: "validate" }), /residualAuthorization|残留授权/);
  passed = true;
});
