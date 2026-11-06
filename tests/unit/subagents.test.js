const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, realpath, rm } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

test("子智能体使用真实 Pi SDK、临时配置和内存 Provider，不请求模型", async t => {
  const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "subagents-")));
  t.after(() => rm(base, { recursive: true, force: true }));
  const result = await promisify(execFile)(process.execPath, [
    "--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
    path.resolve(__dirname, "../helpers/subagents-check.mjs"), base,
  ], { env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent"), PI_OFFLINE: "1" },
    timeout: 45000, maxBuffer: 1024 * 1024 });
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /通过/);
});
