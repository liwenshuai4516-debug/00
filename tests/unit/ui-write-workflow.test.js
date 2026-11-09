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

// 隔离写：授权来源、每轮唯一数据、清理证据与缺失证据不可发布，全部在受控页面执行。
test("隔离写用例：授权、唯一数据、清理证据与发布门槛", { timeout: 120000 }, async (t) => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的内置 Chromium 与 Node 环境。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-ui-write-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留隔离写检查现场：${base}\n`));
  const workspace = path.join(base, "工作区 ' write");
  await fs.mkdir(workspace);
  const created = [];
  const deleted = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");
    if (url.pathname === "/create" || url.pathname === "/delete") {
      const name = url.searchParams.get("name") ?? "";
      if (!/^qa-[\w-]{1,80}$/.test(name)) { res.writeHead(400); res.end("bad name"); return; }
      (url.pathname === "/create" ? created : deleted).push(name);
      res.setHeader("Content-Type", "application/json"); res.end("{\"ok\":true}"); return;
    }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`<!doctype html><html lang="en"><body>
<p data-testid="identity">reviewer</p>
<label>Name<input aria-label="Name"></label>
<button type="button">Create</button>
<ul id="list"></ul>
<script>
const items = [];
const list = document.getElementById("list");
const input = document.querySelector("input");
function render() {
  list.replaceChildren();
  for (const name of items) {
    const row = document.createElement("li");
    row.textContent = name;
    const remove = document.createElement("button");
    remove.type = "button"; remove.textContent = "Delete";
    remove.onclick = async () => {
      await fetch("/delete?name=" + encodeURIComponent(name), { method: "POST" });
      items.splice(items.indexOf(name), 1); render();
    };
    row.append(remove); list.append(row);
  }
}
document.querySelector("button").onclick = async () => {
  const name = input.value; if (!name) return;
  await fetch("/create?name=" + encodeURIComponent(name), { method: "POST" });
  items.push(name); input.value = ""; render();
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
  const caseId = "write-case";
  const taskId = "task-write";
  const taskDir = path.join(workspace, "qa/ui/tasks", taskId);
  await fs.mkdir(path.join(taskDir, "drafts"), { recursive: true });
  const authorization = { kind: "user", reference: "受控写夹具：允许创建和删除本次测试数据" };
  const contract = { mode: "complete", goal: "创建唯一测试数据并清理", role: "reviewer",
    identity: { selector: '[data-testid="identity"]', text: "reviewer" },
    initialState: "受控页面无历史数据；每次执行创建独立对象", dataStrategy: "isolated-write", cleanup: "in-test",
    writeAuthorization: authorization,
    expected: [{ id: "created", text: "本次创建的数据可见，清理后消失", source: { kind: "user", reference: "受控写夹具" } }] };
  await write(path.join(taskDir, "task.json"), { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId, workspace, status: "completed",
    project: { id: "p", name: "Fixture", address: url }, targetUrl: url, contract });
  await fs.writeFile(path.join(taskDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");

  const spec = (attachCleanup) => `const { test, expect } = require("@playwright/test");
test("隔离写新建与清理", async ({ page }, testInfo) => {
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
  await expect(row).toContainText(name);
  const business = testInfo.outputPath("business.png");
  await page.screenshot({ path: business });
  await testInfo.attach("qa-business-result", { path: business, contentType: "image/png" });
  await row.getByRole("button", { name: "Delete" }).click();
  await expect(row).toHaveCount(0);
  const cleanup = testInfo.outputPath("cleanup.png");
  await page.screenshot({ path: cleanup });
  ${attachCleanup ? 'await testInfo.attach("qa-cleanup", { path: cleanup, contentType: "image/png" });' : "// qa-cleanup 证据缺失的负例：只截图不 attach"}
});\n`;
  const metadata = { schema: "qa-ui-case/v1", caseId, taskId, project: { id: "p", name: "Fixture" },
    title: "隔离写新建与清理", modulePath: ["Fixture"], targetUrl: url, role: "reviewer",
    initialState: contract.initialState, dataStrategy: "isolated-write", cleanup: "in-test", writeAuthorization: authorization,
    expected: contract.expected, steps: [{ stepId: "1", text: "创建并清理本次数据" }],
    assertions: [{ kind: "business", expectedId: "created", text: "本次数据可见且清理后消失" }] };
  const draft = path.join(taskDir, "drafts", caseId);
  await fs.mkdir(draft);

  // 脚本必须使用本轮唯一标识并包含清理证据；缺一即拒绝。
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec(true).replaceAll("process.env.QA_RUN_ID", '"fixed-name"'));
  await write(path.join(draft, "case.json"), metadata);
  await assert.rejects(api.saveCandidate(workspace, { taskId, caseId }), /QA_RUN_ID/);
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec(true).replaceAll("qa-cleanup", "cleanup"));
  await assert.rejects(api.saveCandidate(workspace, { taskId, caseId }), /qa-cleanup/);
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec(true));
  const changedAuthorization = structuredClone(metadata);
  changedAuthorization.writeAuthorization = { kind: "rule", reference: "其他来源" };
  await write(path.join(draft, "case.json"), changedAuthorization);
  await assert.rejects(api.saveCandidate(workspace, { taskId, caseId }), /写授权/);
  await write(path.join(draft, "case.json"), metadata);

  // 只读任务不能携带写授权。
  const readTaskId = "task-read";
  const readDir = path.join(workspace, "qa/ui/tasks", readTaskId);
  await fs.mkdir(path.join(readDir, "drafts", "read-case"), { recursive: true });
  const readContract = { ...contract, dataStrategy: "read-only", cleanup: "none", writeAuthorization: undefined };
  await write(path.join(readDir, "task.json"), { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId: readTaskId, workspace, status: "completed",
    project: { id: "p", name: "Fixture", address: url }, targetUrl: url, contract: readContract });
  await fs.writeFile(path.join(readDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");
  await fs.writeFile(path.join(readDir, "drafts/read-case/case.spec.cjs"), spec(true));
  await write(path.join(readDir, "drafts/read-case/case.json"),
    { ...metadata, caseId: "read-case", taskId: readTaskId, dataStrategy: "read-only", cleanup: "none" });
  await assert.rejects(api.saveCandidate(workspace, { taskId: readTaskId, caseId: "read-case" }), /只读用例不能声明写操作授权/);

  const candidate = await api.saveCandidate(workspace, { taskId, caseId });
  const validation = await api.run(workspace, { caseId, revision: candidate.revision, mode: "validate" });
  assert.equal(validation.status, "passed", JSON.stringify((await read(validation.summaryFile)).problems));
  const summary = await read(validation.summaryFile);
  assert.equal(summary.dataStrategy, "isolated-write");
  assert.equal(summary.dataCleanup, "in-test");
  assert.deepEqual(summary.writeAuthorization, authorization);
  await api.publish(workspace, { caseId, revision: candidate.revision, runId: validation.runId });

  // 第二次执行必须使用不同的唯一标识，且本次对象均被清理。
  const regression = await api.regress(workspace, { projectId: "p", caseIds: [caseId] });
  assert.equal(regression.status, "passed", JSON.stringify((await read(regression.summaryFile)).problems));
  assert.equal(created.length, 2, JSON.stringify(created));
  assert.equal(new Set(created).size, 2, "每轮数据必须唯一");
  assert.deepEqual([...deleted].sort(), [...created].sort(), "本次创建的数据必须清理");

  // 缺少清理证据的候选即使脚本提到 qa-cleanup 也不能发布。
  await fs.writeFile(path.join(draft, "case.spec.cjs"), spec(false));
  const missing = await api.saveCandidate(workspace, { taskId, caseId, patchSummary: "负例" });
  const incomplete = await api.run(workspace, { caseId, revision: missing.revision, mode: "validate" });
  assert.notEqual(incomplete.status, "passed");
  assert.ok((await read(incomplete.summaryFile)).problems.some((problem) => problem.includes("qa-cleanup")), "缺少清理证据必须进入报告问题");
  await assert.rejects(api.publish(workspace, { caseId, revision: missing.revision, runId: incomplete.runId }), /passed|发布/);

  passed = true;
});
