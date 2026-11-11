const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");

test("审批准备：配置预检不登录，旧零步骤计划可修订，执行记录阻止修订", async t => {
  const { createReadOnlyWorkflow } = await import("../../src/main/capabilities/ui-testing/workflow.mjs");
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "approval-preparation-")));
  let passed = false;
  t.after(() => passed ? fs.rm(base, { recursive: true, force: true }) : process.stdout.write(`保留审批准备现场：${base}\n`));
  const previousPassword = process.env.QA_UI_TEST_PASSWORD;
  delete process.env.QA_UI_TEST_PASSWORD;
  t.after(() => { if (previousPassword === undefined) delete process.env.QA_UI_TEST_PASSWORD; else process.env.QA_UI_TEST_PASSWORD = previousPassword; });
  const targetUrl = "https://example.invalid/app/new";
  const projectConfig = path.join(base, "projects.json");
  await fs.writeFile(projectConfig, JSON.stringify({ projects: [{ id: "fixture", name: "Fixture", workspaceDir: base, address: "https://example.invalid/app", account: "creator", password: "fixture-private-secret" }] }));
  const { resolveUiTestingRuntime } = require("../../src/main/capabilities/ui-testing/runtime-paths.js");
  const api = createReadOnlyWorkflow({ ...resolveUiTestingRuntime({ isPackaged: false }, path.resolve(__dirname, "../..")), projectConfig });
  const auth = { kind: "user", reference: "isolated fixture" };
  const config = { source: "fixture-rule", record: { selector: "#record", text: "qa-{{runId}}" }, residualAuthorization: auth,
    actors: [{ id: "creator", account: "creator", source: "fixture-directory", credentialSource: "project", identity: { selector: "#identity", text: "creator" } },
      { id: "reviewer", account: "reviewer", source: "fixture-directory", credentialSource: "test-password", identity: { selector: "#identity", text: "reviewer" } }] };
  const result = await api.approval(base, { operation: "preflight", targetUrl, projectId: "fixture", config });
  assert.equal(result.status, "incomplete");
  assert.equal(result.verification, "configuration-only");
  assert.equal(result.projectCredentialsConfigured, true);
  assert.equal(result.sharedTestPasswordConfigured, false);
  assert.deepEqual(result.actors.find(actor => actor.actorId === "reviewer").missing, ["test-password"]);
  assert.ok(!JSON.stringify(result).includes("fixture-private-secret"));
  assert.deepEqual(await fs.readdir(path.join(base, "qa/ui/approvals")).catch(error => error.code === "ENOENT" ? [] : Promise.reject(error)), []);
  const dir = path.join(base, "qa/ui/approvals/legacy");
  await fs.mkdir(dir, { recursive: true });
  const original = { schema: "qa-ui-approval/v1", flowId: "legacy", workspace: base, project: { id: "fixture", name: "Fixture", address: "https://example.invalid/app" }, targetUrl,
    config: { ...config, actors: config.actors.slice(0, 1) }, variables: { runId: "legacy" }, steps: [], createdAt: new Date().toISOString() };
  await fs.writeFile(path.join(dir, "flow.json"), JSON.stringify(original));
  await fs.writeFile(path.join(dir, "old-evidence.txt"), "old inspection evidence");
  const revised = await api.approval(base, { operation: "prepare", flowId: "legacy", baseRevision: 1, config });
  assert.equal(revised.phase, "preparing");
  assert.equal(revised.configRevision, 2);
  const saved = JSON.parse(await fs.readFile(path.join(dir, "flow.json"), "utf8"));
  assert.deepEqual(saved.configHistory[0].config, original.config);
  assert.equal(await fs.readFile(path.join(dir, "old-evidence.txt"), "utf8"), "old inspection evidence");
  await assert.rejects(api.approval(base, { operation: "prepare", flowId: "legacy", baseRevision: 1, config }), /配置版本/);
  const concurrent = await Promise.allSettled(["rule-a", "rule-b"].map(source => api.approval(base, {
    operation: "prepare", flowId: "legacy", baseRevision: 2, config: { ...config, source } })));
  assert.equal(concurrent.filter(item => item.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter(item => item.status === "rejected").length, 1);
  const current = JSON.parse(await fs.readFile(path.join(dir, "flow.json"), "utf8"));
  assert.equal(current.configRevision, 3);
  current.steps.push({ step: { id: "submitted" }, status: "unknown" });
  await fs.writeFile(path.join(dir, "flow.json"), JSON.stringify(current));
  const before = await fs.readFile(path.join(dir, "flow.json"), "utf8");
  await assert.rejects(api.approval(base, { operation: "prepare", flowId: "legacy", baseRevision: 3, config }), /冻结/);
  assert.equal(await fs.readFile(path.join(dir, "flow.json"), "utf8"), before);
  passed = true;
});
