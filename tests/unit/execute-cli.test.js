const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { spawn } = require("node:child_process");
const { createHash } = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { pathToFileURL } = require("node:url");
const { parseArgs, loadProject } = require("../../resources/testing/ui/execute.cjs");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

const repo = path.resolve(__dirname, "../..");
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data));

test("CLI 选择正式 case，拒绝旧选项、缺值、冲突与路径穿越", () => {
  assert.deepEqual(parseArgs(["--project", "p", "--cases", "a,b,a"]).caseIds, ["a", "b"]);
  assert.equal(parseArgs(["--project", "p", "--all"]).all, true);
  assert.equal(parseArgs(["--help"]).help, true);
  for (const option of ["--grep", "--list-users", "--user", "--storage-state", "--headed", "--url", "--tenant"]) {
    assert.throws(() => parseArgs(["--project", "p", "--all", option]), /未知参数/);
  }
  assert.throws(() => parseArgs(["--project", "p", "--cases", "a", "--all"]), /不能同时/);
  assert.throws(() => parseArgs(["--project", "p"]), /缺少 --cases/);
  assert.throws(() => parseArgs(["--project", "--all"]), /缺少参数值/);
  assert.throws(() => parseArgs(["--project", "p", "--all", "--config"]), /缺少参数值/);
  assert.throws(() => parseArgs(["--project", "p", "--cases", "../a"]), /caseId/);
  assert.throws(() => parseArgs(["--project", "p", "--cases", "a,,b"]), /caseId/);
  assert.throws(() => parseArgs(["--project", "p", "--project", "q", "--all"]), /不能重复/);
});

test("项目名必须唯一，项目编号优先；不返回凭据，配置错误不泄露正文", async (t) => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "qa-execute-config-"));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const other = path.join(base, "other"); await fs.mkdir(other);
  const config = path.join(base, "projects.json");
  await write(config, { projects: [
    { id: "p", name: "同名", workspaceDir: base, account: "fixture", password: "fixture-secret" },
    { id: "q", name: "同名", workspaceDir: other },
  ] });
  await assert.rejects(loadProject({ project: "同名", config }), /唯一项目/);
  assert.deepEqual(await loadProject({ project: "p", config }), { projectId: "p", workspace: await fs.realpath(base), configPath: config });
  await fs.writeFile(config, '{"password":"fixture-secret", invalid}');
  await assert.rejects(loadProject({ project: "p", config }), (error) => /配置文件格式无效/.test(error.message) && !error.message.includes("fixture-secret"));
});

test("CLI 真实回放：正式版本批次、拒绝边界、失败与取消收尾（受控页面，无模型）", { timeout: 120000 }, async (t) => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的内置 Chromium 和 Node 环境。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-execute-browser-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留 CLI 检查现场：${base}\n`));
  const workspace = path.join(base, "中文 workspace ' test");
  await fs.mkdir(workspace);
  // 工作区自带 Playwright 时，用例脚本不得就近加载它而混用两份实现。
  await fs.mkdir(path.join(workspace, "node_modules/@playwright/test"), { recursive: true });
  await fs.writeFile(path.join(workspace, "node_modules/@playwright/test/package.json"), '{"name":"@playwright/test","version":"0.0.0-decoy","main":"index.js"}');
  await fs.writeFile(path.join(workspace, "node_modules/@playwright/test/index.js"), 'throw new Error("用例不应加载工作区自带的 @playwright/test");');
  let mode = "pass";
  let ready;
  let loginCount = 0;
  const server = http.createServer(async (req, res) => {
    if (req.url === "/login" && req.method === "POST") {
      let body = ""; for await (const chunk of req) body += chunk;
      assert.equal(new URLSearchParams(body).get("account"), "fixture");
      assert.equal(new URLSearchParams(body).get("password"), "fixture-secret");
      loginCount += 1;
      res.writeHead(302, { "Set-Cookie": "fixture=authenticated; Path=/; HttpOnly", Location: "/" }); res.end(); return;
    }
    if (req.url === "/ready") { res.end("ready"); ready?.(); return; }
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(req.headers.cookie?.includes("fixture=authenticated")
      ? `<p data-testid="identity">reviewer</p><p data-testid="result">${mode === "pass" ? "Beta" : mode === "fail" ? "Wrong" : "Waiting"}</p>`
      : '<form method="POST" action="/login"><input name="account" autocomplete="username"><input name="password" type="password"><button>Login</button></form>');
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const config = path.join(base, "projects.json");
  await write(config, { projects: [{ id: "p", name: "Fixture", workspaceDir: workspace, address: url, account: "fixture", password: "fixture-secret" }] });
  const { createReadOnlyWorkflow } = await import(pathToFileURL(path.join(repo, "src/main/capabilities/ui-testing/workflow.mjs")).href);
  const api = createReadOnlyWorkflow({ ...runtime, projectConfig: config });
  const taskId = "task-fixture";
  const taskDir = path.join(workspace, "qa/ui/tasks", taskId);
  await fs.mkdir(path.join(taskDir, "drafts"), { recursive: true });
  const contract = { mode: "complete", role: "reviewer", identity: { selector: '[data-testid="identity"]', text: "reviewer" },
    initialState: "受控页面固定 Beta", dataStrategy: "read-only", cleanup: "none",
    expected: [{ id: "result", text: "结果为 Beta", source: { kind: "user", reference: "CLI 夹具" } }] };
  // 来源为显式文件夹具；没有执行 browser-use 或模型。发布仍走真实 validate/publish。
  await write(path.join(taskDir, "task.json"), { workflow: "browser-use-playwright", workspace, taskId, status: "completed",
    project: { id: "p", name: "Fixture", address: url }, targetUrl: url, contract });
  await fs.writeFile(path.join(taskDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");
  async function candidate(caseId) {
    const draft = path.join(taskDir, "drafts", caseId); await fs.mkdir(draft, { recursive: true });
    await fs.writeFile(path.join(draft, "case.spec.cjs"), `const { test, expect } = require("@playwright/test");
test(${JSON.stringify(caseId)}, async ({ page }, testInfo) => {
  await page.goto(process.env.QA_TARGET_URL);
  await expect(page.getByTestId("identity")).toHaveText("reviewer");
  const initial = testInfo.outputPath("initial.png");
  await page.screenshot({ path: initial });
  await testInfo.attach("qa-initial-state", { path: initial, contentType: "image/png" });
  await page.request.get(process.env.QA_TARGET_URL + "ready");
  await expect(page.getByTestId("result")).toHaveText("Beta", { timeout: 2000 });
  const business = testInfo.outputPath("business.png");
  await page.screenshot({ path: business });
  await testInfo.attach("qa-business-result", { path: business, contentType: "image/png" });
});\n`);
    await write(path.join(draft, "case.json"), { schema: "qa-ui-case/v1", caseId, taskId, project: { id: "p" }, targetUrl: url,
      role: "reviewer", title: caseId, modulePath: ["Fixture"], initialState: contract.initialState,
      dataStrategy: "read-only", cleanup: "none", expected: contract.expected,
      steps: [{ stepId: "1", text: "核对结果" }], assertions: [{ kind: "business", expectedId: "result", text: "结果为 Beta" }] });
    return api.saveCandidate(workspace, { taskId, caseId });
  }
  for (const caseId of ["alpha", "beta"]) {
    const saved = await candidate(caseId);
    const validation = await api.run(workspace, { caseId, revision: saved.revision, mode: "validate" });
    assert.equal(validation.status, "passed");
    await api.publish(workspace, { caseId, revision: saved.revision, runId: validation.runId });
  }
  await candidate("alpha"); // 新候选不能改变 currentRevision。
  await candidate("candidate");
  const cases = path.join(workspace, "qa/ui/cases");
  await fs.writeFile(path.join(cases, "legacy.spec.cjs"), "invalid legacy must never run");
  await fs.writeFile(path.join(cases, "legacy.asset.json"), "{}");
  await fs.writeFile(path.join(workspace, ".env"), "NOT_A_VALID_ENV\0");
  const before = await Promise.all(["alpha", "beta", "candidate"].map((caseId) => fs.readFile(path.join(cases, caseId, "asset.json"), "utf8")));
  const children = new Set();
  t.after(() => { for (const child of children) child.kill("SIGTERM"); });
  function cli(args) {
    const child = spawn(runtime.node, [path.join(runtime.directory, "execute.cjs"), "--config", config, "--project", "p", ...args], { cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") }, stdio: ["ignore", "pipe", "pipe"] });
    children.add(child);
    let stdout = "", stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    const completed = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => { children.delete(child); resolve({ code, signal, stdout, stderr }); });
    });
    return { child, completed };
  }
  async function rejected(args, pattern) {
    const logins = loginCount;
    const result = await cli(args).completed;
    assert.equal(result.code, 1); assert.match(result.stderr, pattern);
    assert.equal(loginCount, logins, "拒绝发生在登录前");
  }
  await rejected(["--cases", "candidate"], /候选/);
  await fs.symlink(path.join(cases, "alpha"), path.join(cases, "escape"));
  await rejected(["--cases", "escape"], /符号链接/);
  await fs.unlink(path.join(cases, "escape"));
  await fs.writeFile(path.join(workspace, "qa/ui/.workflow.lock"), "fixture active");
  await rejected(["--all"], /已有 UI 任务/);
  await fs.unlink(path.join(workspace, "qa/ui/.workflow.lock"));
  const frozen = path.join(cases, "alpha/revisions/0001/case.spec.cjs");
  const script = await fs.readFile(frozen);
  await fs.appendFile(frozen, "// tampered\n");
  await rejected(["--cases", "alpha"], /revision 文件已变更/);
  await fs.writeFile(frozen, script);
  const mixed = await read(path.join(taskDir, "task.json"));
  const otherTask = path.join(workspace, "qa/ui/tasks/task-other"); await fs.mkdir(otherTask);
  await write(path.join(otherTask, "task.json"), { ...mixed, taskId: "task-other", contract: { ...contract, role: "other" } });
  const betaAssetFile = path.join(cases, "beta/asset.json");
  const betaAsset = await fs.readFile(betaAssetFile);
  const changed = JSON.parse(betaAsset); changed.revisions[0].taskId = "task-other";
  await write(betaAssetFile, changed);
  await rejected(["--all"], /来源任务不一致/);
  const betaMetaFile = path.join(cases, "beta/revisions/0001/case.json");
  const betaMeta = await fs.readFile(betaMetaFile);
  const changedMeta = JSON.parse(betaMeta); changedMeta.taskId = "task-other"; changedMeta.role = "other";
  const changedBytes = JSON.stringify(changedMeta);
  await fs.writeFile(betaMetaFile, changedBytes);
  changed.revisions[0].hashes["case.json"] = createHash("sha256").update(changedBytes).digest("hex");
  await write(betaAssetFile, changed);
  await rejected(["--all"], /批次必须使用同一/);
  await fs.writeFile(betaMetaFile, betaMeta);
  await fs.writeFile(betaAssetFile, betaAsset);
  const all = await cli(["--all"]).completed;
  assert.equal(all.code, 0, all.stderr); assert.equal(all.stderr, "");
  const result = JSON.parse(all.stdout.trim());
  assert.deepEqual(result.revisions, { alpha: "0001", beta: "0001" });
  assert.equal(result.testCount, 2); assert.deepEqual(result.counts, { passed: 2 });
  assert.equal(result.cleanup, "deleted");
  const summary = await read(result.summaryFile);
  assert.equal(summary.workflow, "browser-use-playwright"); assert.equal(summary.purpose, "regression");
  assert.deepEqual(summary.sourceTaskIds, { alpha: taskId, beta: taskId });
  assert.equal(loginCount, 3, "每批后台登录一次，两个 case 共用批次私有状态");
  const single = await cli(["--cases", "beta,beta"]).completed;
  assert.equal(single.code, 0, single.stderr);
  assert.deepEqual(JSON.parse(single.stdout.trim()).revisions, { beta: "0001" });
  mode = "fail";
  const failed = await cli(["--cases", "alpha"]).completed;
  assert.equal(failed.code, 1); assert.equal(JSON.parse(failed.stdout.trim()).status, "failed");
  mode = "cancel";
  const waiting = new Promise((resolve) => { ready = resolve; });
  const cancelling = cli(["--cases", "alpha"]);
  await Promise.race([waiting, cancelling.completed.then((value) => { throw new Error(`取消前进程退出：${JSON.stringify(value)}`); })]);
  cancelling.child.kill("SIGTERM");
  const cancelled = await cancelling.completed;
  assert.equal(cancelled.code, 1, cancelled.stderr); assert.equal(cancelled.signal, null);
  const cancelledResult = JSON.parse(cancelled.stdout.trim());
  assert.equal(cancelledResult.status, "cancelled"); assert.equal(cancelledResult.cleanup, "deleted");
  const task = await read(path.join(path.dirname(cancelledResult.summaryFile), "task.json"));
  assert.equal(task.authFile, undefined); assert.equal(task.authDirectory, undefined);
  assert.equal(existsSync(path.join(workspace, "qa/ui/.workflow.lock")), false);
  assert.deepEqual(await Promise.all(["alpha", "beta", "candidate"].map((caseId) => fs.readFile(path.join(cases, caseId, "asset.json"), "utf8"))), before);
  assert.equal(existsSync(path.join(workspace, "qa/data")), false);
  passed = true;
});
