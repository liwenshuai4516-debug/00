const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { createHash } = require("node:crypto");
const { parseArgs, loadProject, loadCases, resolveSystemUser } = require("../../resources/testing/ui/execute.cjs");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "qa-execute-cli-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  const cases = path.join(workspace, "qa", "data", "ui", "cases");
  await mkdir(cases, { recursive: true });
  const spec = "test('demo', async () => {});\n";
  const specPath = path.join(cases, "pms__demo.spec.cjs");
  await writeFile(specPath, spec);
  const targetUrl = "http://example.invalid/pms/Contract";
  const asset = {
    projectId: "pms",
    targetUrl,
    sha256: createHash("sha256").update(spec).digest("hex"),
  };
  await writeFile(path.join(cases, "pms__demo.asset.json"), JSON.stringify(asset));
  await writeFile(path.join(cases, "pms__demo.md"), "# demo\n");
  const configPath = path.join(base, "projects.json");
  await writeFile(configPath, JSON.stringify({
    projects: [{ id: "pms", name: "项目", workspaceDir: workspace, address: "http://example.invalid", account: "", password: "" }],
  }));
  return { base, workspace, configPath };
}

test("解析执行参数并拒绝冲突的 case 选择", () => {
  assert.deepEqual(parseArgs(["--project", "pms", "--cases", "a,b"]).cases, "a,b");
  assert.deepEqual(parseArgs(["--project", "pms", "--cases", "a", "--grep", "T1"]).grep, "T1");
  assert.throws(() => parseArgs(["--project", "pms", "--cases", "a", "--grep", ""]), /--grep 不能为空/);
  assert.throws(() => parseArgs(["--project", "pms", "--all", "--grep", "T1"]), /--all 与 --grep 不能同时使用/);
  assert.throws(() => parseArgs(["--project", "pms", "--cases", "a", "--all"]), /不能同时使用/);
  assert.throws(() => parseArgs(["--project", "pms"]), /缺少 --cases 或 --all/);
  assert.equal(parseArgs(["--project", "pms", "--list-users"]).listUsers, true);
  assert.throws(() => parseArgs(["--project", "pms", "--list-users", "--cases", "a"]), /不能与/);
  assert.throws(() => parseArgs(["--project", "pms", "--cases", "a", "--user", "姜胤", "--storage-state", "state.json"]), /不能同时使用/);
});

test("按姓名或用户名解析系统用户，拒绝歧义和不存在", () => {
  const users = [
    { name: "姜胤", username: "jiangyin" },
    { name: "姜胤", username: "jiangyin2" },
    { name: "周卫东", username: "zhouweidong" },
  ];
  assert.equal(resolveSystemUser(users, "zhouweidong").username, "zhouweidong");
  assert.throws(() => resolveSystemUser(users, "姜胤"), /多个账号/);
  assert.throws(() => resolveSystemUser(users, "不存在"), /找不到/);
});

test("未传 --url 时从所选 case 推导目标并校验资产哈希", async (t) => {
  const { configPath, workspace } = await setup(t);
  const projectInfo = await loadProject({ project: "pms", config: configPath });
  const cases = await loadCases(projectInfo, { cases: "pms__demo" });

  assert.equal(projectInfo.targetUrl, "http://example.invalid/pms/Contract");
  assert.equal(cases.caseIds[0], "pms__demo");
  assert.equal(cases.caseDir.endsWith(path.join("qa", "data", "ui", "cases")), true);
  assert.equal(cases.caseFiles.length, 1);
  assert.equal(cases.assetFiles.length, 2);
});

test("--all 只选择同项目和同目标的 case", async (t) => {
  const { configPath, workspace } = await setup(t);
  const cases = path.join(workspace, "qa", "data", "ui", "cases");
  const otherSpec = "test('other', async () => {});\n";
  await writeFile(path.join(cases, "pms__other.spec.cjs"), otherSpec);
  await writeFile(path.join(cases, "pms__other.asset.json"), JSON.stringify({
    projectId: "pms",
    targetUrl: "http://example.invalid/pms/Other",
    sha256: createHash("sha256").update(otherSpec).digest("hex"),
  }));
  await writeFile(path.join(cases, "pms__other.md"), "# other\n");
  const projectInfo = await loadProject({ project: "pms", config: configPath, url: "http://example.invalid/pms/Contract" });
  const result = await loadCases(projectInfo, { all: true, cases: undefined });

  assert.deepEqual(result.caseIds, ["pms__demo"]);
});
