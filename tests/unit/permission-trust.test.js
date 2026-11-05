const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

async function setup(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "permission-trust-"));
  const agentDir = path.join(base, "agent");
  const workspace = path.join(base, "workspace");
  await fs.mkdir(agentDir, { recursive: true });
  await fs.mkdir(path.join(workspace, ".pi/skills/fixture"), { recursive: true });
  await fs.writeFile(
    path.join(workspace, ".pi/skills/fixture/SKILL.md"),
    "---\nname: fixture\ndescription: 权限测试技能\n---\n\nfixture\n",
  );
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(async () => {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(base, { recursive: true, force: true });
  });
  return { agentDir, workspace };
}

async function load(t, permissionMode) {
  const { createPiResources } = await import("../../src/main/resources/pi-resources.mjs");
  const { agentDir, workspace } = await setup(t);
  const asked = [];
  const resources = await createPiResources({
    cwd: workspace,
    appendSystemPrompt: [],
    askProjectTrust: async () => {
      asked.push(true);
      return { trusted: false, remember: false };
    },
    onDiagnostics: () => {},
    permissionMode,
  });
  return { agentDir, asked, resources, workspace };
}

test("完全权限自动信任项目资源，不弹项目信任确认", async (t) => {
  const { agentDir, asked, resources } = await load(t, "full-access");
  assert.equal(asked.length, 0);
  assert.equal(resources.settingsManager.isProjectTrusted(), true);
  // 自动信任只作用于本次会话，不把项目静默写入信任库。
  await assert.rejects(fs.stat(path.join(agentDir, "trust.json")), { code: "ENOENT" });
});

test("非完全权限仍按既有信任流程询问，不自动信任", async (t) => {
  const { asked, resources } = await load(t, "ask");
  assert.equal(asked.length, 1);
  assert.equal(resources.settingsManager.isProjectTrusted(), false);
});
