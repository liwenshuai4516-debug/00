const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, realpath } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { existsSync } = require("node:fs");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);

for (const scenario of ["resources", "auto-login"]) {
  test(`内置 UI 测试：${scenario}（临时目录，不请求模型）`, async (t) => {
    const runtime = resolveUiTestingRuntime({ isPackaged: false }, path.resolve(__dirname, "../.."));
    if (scenario !== "resources" && (process.platform === "win32" ||
      ![runtime.node, runtime.testCli, runtime.browsers].every(existsSync))) {
      t.skip("浏览器集成检查需要已准备的内置运行环境与 POSIX shell。");
      return;
    }
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "ui-runtime-")));
    let passed = false;
    t.after(() => passed ? rm(base, { recursive: true, force: true }) : process.stdout.write("保留检查现场：" + base + "\n"));
    const result = await runFile(process.execPath, [
      "--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
      path.resolve(__dirname, "../helpers/ui-testing-runtime-check.mjs"), base, scenario,
    ], {
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") },
      encoding: "utf8",
      timeout: 120_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    assert.equal(result.stderr, "");
    passed = true;
  });
}

test("内置运行时核验覆盖 Python 与固定 browser-use 补丁版本", async (t) => {
  const repo = path.resolve(__dirname, "../..");
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers, runtime.browserPython, runtime.verify].every(existsSync)) {
    t.skip("需要已准备的 Node、浏览器与 browser-use 运行时。");
    return;
  }
  const result = await runFile(runtime.node, [runtime.verify], { encoding: "utf8", timeout: 120_000 });
  const info = JSON.parse(result.stdout.trim());
  const upstream = require(path.join(runtime.directory, "browser-use/upstream.json"));
  assert.equal(info.browserUse, upstream.version);
  assert.match(info.python, /^3\.\d+\.\d+/);
  assert.equal(info.platform, process.platform);
});
