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
  const server = http.createServer((_request, response) => {
    response.setHeader("Content-Type", "text/html; charset=utf-8");
    response.end('<button onclick="this.textContent=\'已完成\'">开始</button>');
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  let session;
  try {
    session = await createPiAgent(
      path.join(base, "sessions"), false, undefined, workspace,
      { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1", apiKey: "offline-test-only" },
      undefined, undefined, undefined, { uiTestingRuntime: runtime },
    );
    const prepared = (await session.agent.state.tools.find((tool) => tool.name === "qa_ui_prepare")
      .execute("record-prepare", { caseId: "button", targetUrl: `http://127.0.0.1:${server.address().port}/`, mode: "record" })).details;
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
    await runFile("/bin/bash", ["-c", prepared.replayCommand], { cwd: workspace, timeout: 90_000 });
    const result = JSON.parse(await fs.readFile(prepared.resultsFile, "utf8"));
    assert.equal(result.stats.expected, 1);
    assert.equal(result.stats.unexpected, 0);
    assert.deepEqual(result.errors, []);
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
