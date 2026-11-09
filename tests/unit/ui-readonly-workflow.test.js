const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { existsSync } = require("node:fs");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

test("生产入口：官方 SDK 四工具、版本回放发布与拒绝边界（离线模型协议夹具）", async (t) => {
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, path.resolve(__dirname, "../.."));
  if (![runtime.node, runtime.testCli, runtime.browsers].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的内置 Chromium 和 Node 环境。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-readonly-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留检查现场：${base}\n`));
  const result = await promisify(execFile)(process.execPath, ["--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
    path.resolve(__dirname, "../helpers/ui-readonly-workflow.check.mjs"), base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") }, encoding: "utf8", timeout: 120000, maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stderr, "");
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(summary.status, "passed");
  assert.equal(summary.checks.length, 8);
  passed = true;
});
