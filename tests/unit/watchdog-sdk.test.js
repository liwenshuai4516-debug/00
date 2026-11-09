const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

test("真实 Pi SDK 看门狗继续与上下文交接，临时配置和内存模型，不请求网络", async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "watchdog-sdk-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const result = await promisify(execFile)(process.execPath, [
    "--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
    path.resolve(__dirname, "../helpers/watchdog-recovery-check.mjs"), base,
  ], { env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") }, timeout: 30000 });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /通过/);
});
