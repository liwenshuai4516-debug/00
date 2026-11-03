import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import http from "node:http";
import { createPiAgent } from "../../src/main/pi-agent.mjs";
import { createUiTestingExtension } from "../../src/main/capabilities/ui-testing/extension.mjs";
import runtimePaths from "../../src/main/capabilities/ui-testing/runtime-paths.js";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

const [base, scenario] = process.argv.slice(2);
const root = fileURLToPath(new URL("../../", import.meta.url));
const runtime = runtimePaths.resolveUiTestingRuntime({ isPackaged: false }, root);
const workspace = path.join(base, "页面测试 ' workspace");
const runFile = promisify(execFile);
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(process.env.PI_CODING_AGENT_DIR, { recursive: true });

if (scenario === "resources") {
  for (const enabled of [false, true, "disabled"]) {
    await fs.writeFile(path.join(process.env.PI_CODING_AGENT_DIR, "settings.json"),
      JSON.stringify(enabled === "disabled" ? { extensions: ["-builtin:desktop-ui-testing"] } : {}));
    const diagnostics = [];
    const session = await createPiAgent(
      path.join(base, "sessions"), false, undefined, workspace,
      { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "offline-test-only" },
      undefined, undefined, undefined,
      { uiTestingRuntime: enabled ? runtime : undefined, onDiagnostics: (items) => diagnostics.push(...items) },
    );
    try {
      const expected = enabled === true ? 1 : 0;
      const extensions = session.resourceLoader.getExtensions().extensions;
      assert.equal(extensions.filter((entry) => entry.tools.has("qa_ui_prepare")).length, expected,
        "扩展必须按需且只登记一次");
      assert.equal(session.getAllTools().filter((tool) => tool.name === "qa_ui_prepare").length, expected);
      assert.equal(session.resourceLoader.getSkills().skills.filter((skill) => skill.name === "qa-ui-basic").length, expected);
      assert.deepEqual(diagnostics, []);
    } finally {
      await lifecycle.closePiSession(session);
    }
  }
}

if (scenario === "recording") {
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/login") {
      response.setHeader("Set-Cookie", "recording_identity=fixture; HttpOnly; Path=/");
      response.end("临时登录完成");
      return;
    }
    response.end(request.headers.cookie?.includes("recording_identity=fixture")
      ? '<button onclick="this.textContent=\'已完成\'">开始</button>' : "请先登录");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let session;
  try {
    session = await createPiAgent(
      path.join(base, "sessions"), false, undefined, workspace,
      { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "offline-test-only" },
      undefined, undefined, undefined, { uiTestingRuntime: runtime },
    );
    session.extensionRunner.setUIContext({ async confirm() { return true; } }, "rpc");
    const targetUrl = `http://127.0.0.1:${server.address().port}/`;
    const loginTool = session.agent.state.tools.find((tool) => tool.name === "qa_ui_login");
    const login = (await loginTool.execute("login-start", { action: "start", targetUrl: targetUrl + "login" })).details;
    assert.equal((await loginTool.execute("login-save", { action: "complete", loginId: login.loginId })).details.status, "saved");
    const prepared = (await session.agent.state.tools.find((tool) => tool.name === "qa_ui_prepare")
      .execute("record-prepare", { caseId: "button", targetUrl, mode: "record", loginId: login.loginId, headed: true })).details;
    const prefix = "mcp__desktop_playwright_test__";
    for (let attempt = 0; attempt < 200 && !session.getActiveToolNames().includes(`${prefix}generator_setup_page`); attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const call = async (name, args) => {
      const tool = session.agent.state.tools.find((item) => item.name === `${prefix}${name}`);
      assert.ok(tool, `必须由 Pi 发现官方工具：${name}`);
      const result = await tool.execute(`fixture-${name}`, args);
      assert.ok(!result.isError, JSON.stringify(result.content));
      return result;
    };
    const setup = await call("generator_setup_page", {
      seedFile: prepared.seedFile, project: "chromium", plan: "点击开始按钮，验证文本变成已完成。",
    });
    const snapshot = JSON.stringify(setup.content);
    const ref = snapshot.match(/button.*?ref=(e\d+)/)?.[1];
    assert.ok(ref, snapshot);
    await call("browser_click", { element: "开始按钮", target: ref, intent: "点击开始" });
    const log = await call("generator_read_log", {});
    assert.match(JSON.stringify(log.content), /click/);
    // 无模型测试显式投递真实工具结果，单独验证宿主的证据保存钩子。
    await session.extensionRunner.emit({
      type: "tool_result", toolName: `${prefix}generator_read_log`, toolCallId: "fixture-log",
      input: {}, content: log.content, isError: false, details: log.details,
    });
    const evidence = (await fs.readdir(prepared.recordingDir)).find((name) => name.startsWith("generator-log-"));
    assert.ok(evidence);
    assert.deepEqual(JSON.parse(await fs.readFile(path.join(prepared.recordingDir, evidence), "utf8")).content, log.content);
    await call("generator_write_test", {
      fileName: prepared.caseFileName,
      code: `const { test, expect } = require("@playwright/test");
test("button", async ({ page }) => {
  await page.goto(process.env.QA_TARGET_URL);
  await page.getByRole("button", { name: "开始" }).click();
  await expect(page.getByRole("button")).toHaveText("已完成");
});\n`,
    });
    await call("browser_close", { intent: "录制完成，关闭页面" });
    const replay = (await session.agent.state.tools.find((tool) => tool.name === "qa_ui_prepare")
      .execute("record-run", { caseId: "button", targetUrl, mode: "run", loginId: login.loginId })).details;
    await runFile("/bin/bash", ["-c", replay.replayCommand], { cwd: workspace, timeout: 90_000 });
    const result = JSON.parse(await fs.readFile(replay.resultsFile, "utf8"));
    assert.equal(result.stats.expected, 1);
    assert.equal(result.stats.unexpected, 0);
    assert.deepEqual(result.errors, []);
    const summary = JSON.parse(await fs.readFile(replay.summaryFile, "utf8"));
    assert.equal(summary.status, "passed");
    assert.equal(summary.cleanup, "deleted");
    assert.equal(summary.tracePolicy, "disabled-for-private-auth");
  } finally {
    await lifecycle.closePiSession(session);
    await new Promise((resolve) => server.close(resolve));
  }
}

if (scenario === "replay") {
  const alias = path.join(base, "运行环境 ' alias");
  await fs.symlink(runtime.directory, alias);
  const replayRuntime = Object.fromEntries(Object.entries(runtime).map(
    ([key, value]) => [key, value.replace(runtime.directory, alias)],
  ));
  // 仅替代 Pi 工具登记；环境检查、shell 和测试执行均使用真实运行环境。
  let prepare;
  createUiTestingExtension(replayRuntime)({
    on() {},
    unregisterMcpServer() {},
    registerTool(tool) { prepare = tool; },
    async exec(command, args, options) {
      try {
        const result = await runFile(command, args, options);
        return { ...result, code: 0, killed: false };
      } catch (error) {
        return { ...error, code: error.code, killed: error.killed };
      }
    },
  });
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end(`<input aria-label="待办"><ul></ul><script>
      document.querySelector('input').onkeydown = (event) => {
        if (event.key !== 'Enter') return;
        const item = document.createElement('li');
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        item.append(checkbox, event.target.value);
        document.querySelector('ul').append(item); event.target.value = '';
      };
    </script>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const targetUrl = `http://127.0.0.1:${server.address().port}/?owner=O'Reilly&text=hello world`;
    const caseDir = path.join(workspace, "qa/ui/cases");
    await fs.mkdir(caseDir, { recursive: true });
    const caseFile = path.join(caseDir, "add-todo.spec.cjs");
    const source = `const { test, expect } = require("@playwright/test");
test("新增待办的四项断言", async ({ page }) => {
  expect(process.env.QA_TARGET_URL).toBe(${JSON.stringify(targetUrl)});
  await page.goto(process.env.QA_TARGET_URL);
  const input = page.getByRole("textbox", { name: "待办" });
  await input.fill("回归测试"); await input.press("Enter");
  const items = page.getByRole("listitem");
  await expect(items).toHaveCount(1);
  await expect(items.first()).toHaveText("回归测试");
  await expect(items.getByRole("checkbox")).not.toBeChecked();
  await expect(input).toHaveValue("");
});\n`;
    await fs.writeFile(caseFile, source);
    for (const name of ["add-todo.seed.spec.cjs", "other-add-todo.spec.cjs", "add-todoXspecYcjs.spec.cjs"]) {
      await fs.writeFile(path.join(caseDir, name), 'throw new Error("不应加载其他 case 或 seed");');
    }
    const prepared = (await prepare.execute("prepare", { caseId: "add-todo", targetUrl, mode: "run" },
      new AbortController().signal, undefined, { cwd: workspace })).details;
    assert.equal(prepared.status, "prepared");
    // 使用包含空格、单引号的运行时路径，核对命令引用和环境变量原样传递。
    await runFile("/bin/bash", ["-c", prepared.replayCommand], { cwd: workspace, timeout: 90_000 });
    const result = JSON.parse(await fs.readFile(prepared.resultsFile, "utf8"));
    assert.equal(result.stats.expected, 1);
    assert.equal(result.stats.unexpected, 0);
    assert.equal(result.stats.skipped, 0);
    assert.equal(result.stats.flaky, 0);
    assert.deepEqual(result.errors, []);
    assert.equal(JSON.parse(await fs.readFile(prepared.summaryFile, "utf8")).status, "passed");
    await fs.access(prepared.htmlReport);
    const collect = (suites) => suites.flatMap((suite) => [
      ...(suite.specs ?? []).flatMap((spec) => spec.tests.flatMap((test) => test.results.flatMap((result) => result.attachments))),
      ...collect(suite.suites ?? []),
    ]);
    assert.ok(collect(result.suites).some((attachment) => attachment.name === "trace"));
    // 失败必须原样落入新批次，不能覆盖先前通过记录。
    await fs.writeFile(caseFile, source.replace('toHaveText("回归测试")', 'toHaveText("错误预期", { timeout: 100 })'));
    const failed = (await prepare.execute("prepare-failed", { caseId: "add-todo", targetUrl, mode: "run" },
      new AbortController().signal, undefined, { cwd: workspace })).details;
    await assert.rejects(runFile("/bin/bash", ["-c", failed.replayCommand], { cwd: workspace, timeout: 90_000 }),
      (error) => error.code === 1);
    const failure = JSON.parse(await fs.readFile(failed.resultsFile, "utf8"));
    assert.equal(failure.stats.unexpected, 1);
    assert.equal(failure.stats.expected, 0);
    assert.ok(collect(failure.suites).some((attachment) => attachment.name === "screenshot"));
    assert.notEqual(failed.runDir, prepared.runDir);
    assert.equal(JSON.parse(await fs.readFile(prepared.resultsFile, "utf8")).stats.expected, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

if (scenario === "login-batch") {
  process.env.TMPDIR = base;
  const tools = new Map();
  const hooks = new Map();
  createUiTestingExtension(runtime)({
    on(name, callback) { hooks.set(name, callback); },
    registerTool(tool) { tools.set(tool.name, tool); },
    unregisterMcpServer() {},
    async exec(command, args, options) {
      try { return { ...await runFile(command, args, options), code: 0 }; }
      catch (error) { return { ...error, code: error.code }; }
    },
  });
  let consent = true;
  const ctx = { cwd: workspace, hasUI: true, ui: { async confirm() { return consent; } } };
  const call = async (name, params) => (await tools.get(name).execute("fixture", params,
    new AbortController().signal, undefined, ctx)).details;
  const server = http.createServer((request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    if (request.url === "/login") {
      response.setHeader("Set-Cookie", "fixture_identity=private-fixture-token-20261103; HttpOnly; Path=/");
      response.end('<script>localStorage.setItem("fixture-role", "operator")</script>临时登录页面');
    } else {
      response.end(request.headers.cookie?.includes("fixture_identity=private-fixture-token-20261103") ? "身份：operator" : "未登录");
    }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const targetUrl = origin + "/login";
  const authDirs = async () => (await fs.readdir(base)).filter((name) => name.startsWith("qa-ui-auth-"));
  try {
    await assert.rejects(call("qa_ui_login", { action: "start", targetUrl: "http://user:password@127.0.0.1/" }), /不能包含/);
    const rejected = await call("qa_ui_login", { action: "start", targetUrl });
    consent = false;
    assert.equal((await call("qa_ui_login", { action: "complete", loginId: rejected.loginId })).cleanup, "deleted");
    assert.deepEqual(await authDirs(), []);
    consent = true;
    const login = await call("qa_ui_login", { action: "start", targetUrl });
    assert.equal((await call("qa_ui_login", { action: "complete", loginId: login.loginId })).status, "saved");
    const privateDir = path.join(base, (await authDirs())[0]);
    const authFile = path.join(privateDir, "state.json");
    assert.equal((await fs.stat(privateDir)).mode & 0o777, 0o700);
    assert.equal((await fs.stat(authFile)).mode & 0o777, 0o600);
    const state = JSON.parse(await fs.readFile(authFile, "utf8"));
    assert.equal(state.cookies[0].name, "fixture_identity");
    assert.equal(state.origins[0].localStorage[0].name, "fixture-role");
    const caseDir = path.join(workspace, "qa/ui/cases");
    await fs.mkdir(caseDir, { recursive: true });
    await fs.writeFile(path.join(caseDir, "identity.spec.cjs"), `const { test, expect } = require("@playwright/test");
      test("独立上下文读取登录身份", async ({ page }) => {
        await page.goto(${JSON.stringify(origin)});
        await expect(page.locator("body")).toHaveText("身份：operator");
      });
      test("交接 localStorage", async ({ page }) => {
        await page.goto(${JSON.stringify(origin)});
        expect(await page.evaluate(() => localStorage.getItem("fixture-role"))).toBe("operator");
      });`);
    await fs.writeFile(path.join(caseDir, "outcomes.spec.cjs"), `const { test, expect } = require("@playwright/test");
      test("真实失败保留", () => { expect(1).toBe(2); });
      test.skip("不能将跳过记为通过", () => {});`);
    await assert.rejects(call("qa_ui_prepare", { mode: "run", caseId: "identity", targetUrl: "http://example.invalid", loginId: login.loginId }), /目标站点/);
    const batch = await call("qa_ui_prepare", { mode: "run", caseIds: ["identity", "outcomes"], targetUrl: origin, loginId: login.loginId });
    await assert.rejects(call("qa_ui_prepare", { mode: "run", caseId: "identity", targetUrl: origin, loginId: login.loginId }), /已绑定/);
    await assert.rejects(runFile("/bin/bash", ["-c", batch.replayCommand], { cwd: workspace, timeout: 90_000 }), (error) => error.code === 1);
    assert.deepEqual(await authDirs(), []);
    const summary = JSON.parse(await fs.readFile(batch.summaryFile, "utf8"));
    assert.equal(summary.status, "failed");
    assert.deepEqual(summary.counts, { passed: 2, failed: 1, skipped: 1 });
    assert.equal(summary.testCount, 4);
    assert.equal(summary.cleanup, "deleted");
    assert.equal(summary.tracePolicy, "disabled-for-private-auth");
    assert.ok(summary.tests.every((test) => test.attachments.every((attachment) => attachment.name !== "trace")));
    assert.deepEqual(summary.problems, []);
    assert.ok(summary.versions.files.every((file) => file.sha256 === file.afterSha256));
    const manifest = JSON.parse(await fs.readFile(batch.manifestFile, "utf8"));
    assert.ok(manifest.files.some((file) => file.path === "summary.md"));
    assert.ok(manifest.files.some((file) => file.path === "results.json"));
    for (const item of manifest.files) {
      const data = await fs.readFile(path.join(batch.runDir, item.path));
      const { createHash } = await import("node:crypto");
      assert.equal(item.sha256, createHash("sha256").update(data).digest("hex"));
      assert.ok(!item.path.includes("state.json"));
      assert.ok(!data.includes(Buffer.from("private-fixture-token-20261103")), "证据不能包含临时认证值");
    }
    assert.ok(!("authFile" in JSON.parse(await fs.readFile(path.join(batch.runDir, "task.json"), "utf8"))));
    await assert.rejects(runFile("/bin/bash", ["-c", batch.replayCommand], { cwd: workspace }), /EEXIST/);
    // 准备后变更脚本必须阻止执行，不能把新版本伪装成获选版本。
    const changed = await call("qa_ui_prepare", { mode: "run", caseId: "identity", targetUrl: origin });
    await fs.appendFile(path.join(caseDir, "identity.spec.cjs"), "\n// changed");
    await assert.rejects(runFile("/bin/bash", ["-c", changed.replayCommand], { cwd: workspace }), (error) => error.code === 1);
    const incomplete = JSON.parse(await fs.readFile(changed.summaryFile, "utf8"));
    assert.equal(incomplete.status, "incomplete");
    assert.equal(incomplete.testCount, null);
    assert.match(incomplete.problems.join(" "), /脚本已变更/);
    // 有脚本没有任何 test 时，不能仅凭其余测试通过判整个范围通过。
    await fs.writeFile(path.join(caseDir, "plain.spec.cjs"), 'const { test, expect } = require("@playwright/test"); test("通过", () => expect(1).toBe(1));');
    await fs.writeFile(path.join(caseDir, "empty.spec.cjs"), "// no tests");
    const empty = await call("qa_ui_prepare", { mode: "run", caseIds: ["plain", "empty"], targetUrl: origin });
    await assert.rejects(runFile("/bin/bash", ["-c", empty.replayCommand], { cwd: workspace }), (error) => error.code === 1);
    const emptySummary = JSON.parse(await fs.readFile(empty.summaryFile, "utf8"));
    assert.equal(emptySummary.status, "incomplete");
    assert.match(emptySummary.problems.join(" "), /所选脚本没有测试结果/);
    // 取消正在执行的批次同样要清理私有登录态并生成摘要。
    const cancelLogin = await call("qa_ui_login", { action: "start", targetUrl });
    await call("qa_ui_login", { action: "complete", loginId: cancelLogin.loginId });
    await fs.writeFile(path.join(caseDir, "slow.spec.cjs"), `const { test } = require("@playwright/test");
      test("等待取消", async () => {
        require("node:fs").writeFileSync(require("node:path").join(process.env.QA_UI_OUTPUT_DIR, "ready"), "ready");
        await new Promise(() => {});
      });`);
    const cancelled = await call("qa_ui_prepare", { mode: "run", caseId: "slow", targetUrl: origin, loginId: cancelLogin.loginId });
    const { spawn } = await import("node:child_process");
    const child = spawn(runtime.node, [runtime.runner, path.join(cancelled.runDir, "task.json")], { cwd: workspace, stdio: "ignore" });
    const closed = new Promise((resolve) => child.once("close", resolve));
    try {
      for (let attempt = 0; attempt < 200; attempt++) {
        try { await fs.access(path.join(cancelled.runDir, "ready")); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 50)); }
      }
      await fs.access(path.join(cancelled.runDir, "ready"));
      child.kill("SIGTERM");
      assert.equal(await closed, 1);
      assert.equal(JSON.parse(await fs.readFile(cancelled.summaryFile, "utf8")).status, "cancelled");
      assert.deepEqual(await authDirs(), []);
    } finally { child.kill("SIGKILL"); }
    // 尚未绑定批次的登录态由 session_shutdown 回收。
    const abandoned = await call("qa_ui_login", { action: "start", targetUrl });
    await call("qa_ui_login", { action: "complete", loginId: abandoned.loginId });
    await hooks.get("session_shutdown")();
    assert.deepEqual(await authDirs(), []);
    const cancelledWindow = await call("qa_ui_login", { action: "start", targetUrl });
    assert.equal((await call("qa_ui_login", { action: "cancel", loginId: cancelledWindow.loginId })).status, "deleted");
    assert.deepEqual(await authDirs(), []);
    assert.deepEqual((await fs.readdir(base)).filter((name) => name.startsWith("playwright_chromiumdev_profile-")), [], "登录窗口及临时浏览器资料也必须回收");
  } finally {
    await hooks.get("session_shutdown")();
    await new Promise((resolve) => server.close(resolve));
  }
}
