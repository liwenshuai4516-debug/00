const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");

for (const scenario of ["startup", "configuration", "extension", "reload", "stream", "unavailable-startup"]) {
  test(`Pi Custom Providers：${scenario}（隔离资源与本地协议夹具）`, async t => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pi-custom-providers-"));
    t.after(() => fs.rm(root, { recursive: true, force: true }));
    const result = await promisify(execFile)(process.execPath, [
      "--require", path.resolve(__dirname, "../helpers/pi-test-isolation.cjs"),
      path.resolve(__dirname, "../helpers/custom-providers-check.mjs"), root, scenario,
    ], { env: { ...process.env, PI_CODING_AGENT_DIR: path.join(root, "agent"), PI_OFFLINE: "1" }, timeout: 30000, maxBuffer: 1024 * 1024 });
    assert.equal(result.stderr, "");
  });
}
