const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { existsSync } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

test("browser-use：自定义下拉两次点击与原生下拉（真实本地控件，无模型）", async t => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, path.resolve(__dirname, "../.."));
  if (![runtime.browserPython, runtime.testCli, runtime.browsers].every(existsSync)) {
    t.skip("需要已准备的 browser-use 和 Chromium 运行时。"); return;
  }
  const { stdout: executable } = await promisify(execFile)(runtime.node, ["-e", "process.stdout.write(require('@playwright/test').chromium.executablePath())"], {
    cwd: runtime.directory, env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: runtime.browsers }, timeout: 10000,
  });
  const result = await promisify(execFile)(runtime.browserPython, ["-B", path.resolve(__dirname, "../helpers/browser-use-dropdown.check.py"), executable], {
    env: { ...process.env, QA_UI_TEST_PASSWORD: "" }, timeout: 90000, maxBuffer: 1024 * 1024,
  });
  assert.match(result.stdout, /custom-clicks\/native-select: passed; model calls: 0/);
});
