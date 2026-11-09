const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const { createHash } = require("node:crypto");
const http = require("node:http");
const { once } = require("node:events");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");
const { copySharedModules } = require("../../tooling/testing/ui/shared-runtime.cjs");

const repo = path.resolve(__dirname, "../..");
const runFile = promisify(execFile);
const hash = (data) => createHash("sha256").update(data).digest("hex");

// 模拟安装包 resources/testing/ui 布局：不依赖开发仓库相对路径，验证共享实现随包加载。
// 这是资源布局验收，不是真实安装包或跨平台验收。
test("打包资源布局：共享实现从随包 lib 加载并完成真实回放", { timeout: 120000 }, async (t) => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers, runtime.browserPython].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的 Node、浏览器与 browser-use 运行时，且当前仅验证 POSIX 布局。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "qa-ui-packaged-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留打包布局检查现场：${base}\n`));
  const resources = path.join(base, "resources");
  const runtimeDir = path.join(resources, "testing/ui");
  await fs.mkdir(runtimeDir, { recursive: true });
  for (const name of ["node_modules", "browsers", "bin", "browser-use"]) {
    await fs.symlink(path.join(repo, "resources/testing/ui", name), path.join(runtimeDir, name), "dir");
  }
  for (const name of ["verify.cjs", "run.cjs", "execute.cjs", "shared.cjs", "playwright.config.cjs", "playwright-resolve.cjs", "login.cjs"]) {
    await fs.copyFile(path.join(repo, "resources/testing/ui", name), path.join(runtimeDir, name));
  }
  copySharedModules(repo, runtimeDir);

  const packaged = resolveUiTestingRuntime({ isPackaged: true }, repo, { resourcesPath: resources });
  assert.equal(packaged.directory, runtimeDir);
  assert.ok(existsSync(path.join(runtimeDir, "lib/capabilities/ui-testing/workflow.mjs")), "共享实现必须复制到随包 lib");
  assert.equal(require(path.join(runtimeDir, "shared.cjs")).packaged, true, "CLI 必须识别打包布局");
  const upstream = require(path.join(repo, "resources/testing/ui/browser-use/upstream.json"));
  const verified = JSON.parse((await runFile(packaged.node, [path.join(runtimeDir, "verify.cjs")], { encoding: "utf8", timeout: 60_000 })).stdout.trim());
  assert.equal(verified.browserUse, upstream.version);
  assert.equal(verified.platform, process.platform);
  const help = await runFile(packaged.node, [path.join(runtimeDir, "execute.cjs"), "--help"], { encoding: "utf8" });
  assert.match(help.stdout, /用法/);

  // 真实回放走随包执行器、配置和用例，证明共享实现与运行时目录一致。
  const workspace = path.join(base, "workspace");
  await fs.mkdir(workspace);
  let hits = 0;
  const server = http.createServer((req, res) => {
    if (!req.url.startsWith("/ready")) hits += 1;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(req.url.startsWith("/ready") ? "ready" : '<p data-testid="identity">reviewer</p><p data-testid="result">Beta</p>');
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/`;
  const caseId = "packaged-case";
  const taskId = "task-packaged";
  const taskDir = path.join(workspace, "qa/ui/tasks", taskId);
  await fs.mkdir(taskDir, { recursive: true });
  const contract = { mode: "complete", goal: "核对结果", role: "reviewer",
    identity: { selector: '[data-testid="identity"]', text: "reviewer" },
    initialState: "受控页面固定 Beta", dataStrategy: "read-only", cleanup: "none",
    expected: [{ id: "result", text: "结果为 Beta", source: { kind: "user", reference: "打包布局夹具" } }] };
  await fs.writeFile(path.join(taskDir, "task.json"), JSON.stringify({ schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId, workspace,
    status: "completed", project: { id: "p", name: "Fixture", address: url }, targetUrl: url, contract }));
  await fs.writeFile(path.join(taskDir, "actions.jsonl"), JSON.stringify({ stepId: "1", result: [{ success: true }] }) + "\n");

  const revisionDir = path.join(workspace, "qa/ui/cases", caseId, "revisions/0001");
  await fs.mkdir(revisionDir, { recursive: true });
  const spec = `const { test, expect } = require("@playwright/test");
test("打包布局回放", async ({ page }, testInfo) => {
  await page.goto(process.env.QA_TARGET_URL);
  await expect(page.getByTestId("identity")).toHaveText("reviewer");
  const initial = testInfo.outputPath("initial.png");
  await page.screenshot({ path: initial });
  await testInfo.attach("qa-initial-state", { path: initial, contentType: "image/png" });
  await expect(page.getByTestId("result")).toHaveText("Beta");
  const business = testInfo.outputPath("business.png");
  await page.screenshot({ path: business });
  await testInfo.attach("qa-business-result", { path: business, contentType: "image/png" });
});\n`;
  const meta = { schema: "qa-ui-case/v1", caseId, taskId, project: { id: "p", name: "Fixture" }, title: "打包布局回放",
    modulePath: ["Fixture"], targetUrl: url, role: "reviewer", initialState: contract.initialState,
    dataStrategy: "read-only", cleanup: "none", expected: contract.expected,
    steps: [{ stepId: "1", text: "核对结果" }], assertions: [{ kind: "business", expectedId: "result", text: "结果为 Beta" }] };
  await fs.writeFile(path.join(revisionDir, "case.spec.cjs"), spec);
  const metaBytes = Buffer.from(JSON.stringify(meta));
  await fs.writeFile(path.join(revisionDir, "case.json"), metaBytes);
  await fs.writeFile(path.join(workspace, "qa/ui/cases", caseId, "asset.json"), JSON.stringify({
    schema: "qa-ui-asset/v1", caseId, currentRevision: "0001",
    revisions: [{ revision: "0001", taskId, hashes: { "case.spec.cjs": hash(Buffer.from(spec)), "case.json": hash(metaBytes) }, validatedRunId: "run-prior" }],
  }));
  const config = path.join(base, "projects.json");
  await fs.writeFile(config, JSON.stringify({ projects: [{ id: "p", name: "Fixture", workspaceDir: workspace, address: url }] }));

  const result = await runFile(packaged.node, [path.join(runtimeDir, "execute.cjs"), "--config", config, "--project", "p", "--cases", caseId], {
    cwd: workspace, env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") },
    encoding: "utf8", timeout: 90_000, maxBuffer: 2 * 1024 * 1024,
  });
  const output = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(output.status, "passed", result.stderr);
  assert.equal(output.revisions[caseId], "0001");
  const summary = JSON.parse(await fs.readFile(output.summaryFile, "utf8"));
  assert.equal(summary.workspace, workspace);
  assert.equal(summary.purpose, "regression");
  assert.ok(hits > 0);
  passed = true;
});
