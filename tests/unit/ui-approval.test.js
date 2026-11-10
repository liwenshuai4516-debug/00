const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { existsSync } = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");

test("审批分支：动态提示词、多身份节点、上传、完整链候选回放及结果核对", { timeout: 180000 }, async t => {
  const repo = path.resolve(__dirname, "../..");
  const runtime = resolveUiTestingRuntime({ isPackaged: false }, repo);
  if (![runtime.node, runtime.testCli, runtime.browsers].every(existsSync) || process.platform === "win32") {
    t.skip("需要已准备的内置 Chromium 和 Node 环境。"); return;
  }
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "ui-approval-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留审批检查现场：${base}\n`));
  const output = await promisify(execFile)(process.execPath, [path.join(repo, "tests/helpers/ui-approval-check.mjs"), base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") }, encoding: "utf8", timeout: 170000, maxBuffer: 4 * 1024 * 1024,
  });
  assert.equal(output.stderr, "");
  assert.equal(JSON.parse(output.stdout.trim().split("\n").at(-1)).status, "passed");
  passed = true;
});
