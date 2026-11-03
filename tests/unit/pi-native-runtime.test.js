const { test } = require("node:test");
const assert = require("node:assert/strict");
const { mkdtemp, rm, realpath } = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");
const runFile = promisify(execFile);

for (const scenario of ["resources", "trust", "lifecycle", "settings", "mcp"]) {
  test(`Pi 原生适配：${scenario}（临时资源，不请求模型）`, async t => {
    const base = await realpath(await mkdtemp(path.join(os.tmpdir(), "pi-native-test-")));
    t.after(() => rm(base, { recursive: true, force: true }));
    const result = await runFile(process.execPath, [
      "--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
      path.resolve(__dirname, "../helpers/pi-native-runtime-check.mjs"), base, scenario,
    ], {
      env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") },
      encoding: "utf8",
    });
    assert.equal(result.stderr, "");
  });
}
