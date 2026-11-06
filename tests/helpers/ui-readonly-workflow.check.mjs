import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { ModelRuntime, DefaultResourceLoader, SettingsManager, SessionManager, createAgentSession } from "@mariozechner/pi-coding-agent";
import { createReadOnlyWorkflowExtension } from "../../src/main/capabilities/ui-testing/workflow-extension.mjs";
import { createReadOnlyWorkflow } from "../../src/main/capabilities/ui-testing/workflow.mjs";
import paths from "../../src/main/capabilities/ui-testing/runtime-paths.js";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

const [base, scenario = "offline"] = process.argv.slice(2);
const real = scenario === "real";
const workspace = path.join(base, "只读 workspace ' test");
const agentDir = path.join(base, "agent");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));
const requests = [];
const app = `<!doctype html><html lang="en"><head><title>Read-only workflow fixture</title></head><body>
<h1>Accounts</h1><p data-testid="identity">fixture-reviewer</p>
<label>Filter<input aria-label="Filter" data-testid="filter"></label>
<table><tbody><tr data-row="Alpha"><td>Alpha</td><td><button>Detail</button></td></tr>
<tr data-row="Beta"><td>Beta</td><td><button>Detail</button></td></tr></tbody></table>
<p role="status">No detail selected</p><script>
document.querySelector('input').oninput=e=>document.querySelectorAll('tr').forEach(row=>row.hidden=!row.dataset.row.includes(e.target.value));
document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{
 document.querySelector('[role="status"]').textContent='Loading';
 const data=await(await fetch('/detail?id='+button.closest('tr').dataset.row)).json();
 document.querySelector('[role="status"]').textContent=data.text;
});</script></body></html>`;
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/detail") {
    requests.push(url.searchParams.get("id"));
    setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: `${url.searchParams.get("id")} · ready` })); }, 100);
  } else { res.setHeader("Content-Type", "text/html; charset=utf-8"); res.end(app); }
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;
const runtime = { ...paths.resolveUiTestingRuntime({ isPackaged: false }, path.resolve(import.meta.dirname, "../..")), projectConfig: path.join(base, "projects.json") };
await write(runtime.projectConfig, { projects: [{ id: "fixture", name: "Fixture", workspaceDir: workspace, address: url }] });
let modelRuntime;
if (real) modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
else {
  await write(path.join(agentDir, "models.json"), { providers: { fixture: { baseUrl: "https://fixture.invalid/v1", api: "openai-completions", apiKey: "fixture-key-not-real", models: [{ id: "fixture-model", name: "Fixture", reasoning: false, input: ["text"], contextWindow: 32768, maxTokens: 4096 }] } } });
  modelRuntime = await ModelRuntime.create({ authPath: path.join(agentDir, "auth.json"), modelsPath: path.join(agentDir, "models.json"), modelsStorePath: path.join(agentDir, "models-store.json"), refreshOnCreate: false, allowModelNetwork: false });
  // 协议夹具显式替代 Python；不声称发生真实探索或真实模型请求。
  const python = path.join(base, "protocol-fixture.cjs");
  await fs.writeFile(python, `#!${process.execPath}
const fs=require('node:fs'); const {createInterface}=require('node:readline');
const lines=createInterface({input:process.stdin}); let start;
function emit(value){process.stdout.write(JSON.stringify({taskId:start.taskId,...value})+'\\n');}
lines.on('line',line=>{const m=JSON.parse(line);if(!start){start=m;
if(m.goal==='cancel-fixture'){emit({type:'progress',phase:'browser-ready'});return;}
if(m.goal==='unknown-fixture'){emit({type:'done',status:'unknown',cleanupConfirmed:false});return;}
const records=['navigate','input','click','done'].map((name,i)=>({stepId:String(i+1),url:m.url,action:{[name]:{}},result:[{is_done:name==='done'}]}));
fs.writeFileSync(m.output+'/actions.jsonl',records.map(x=>JSON.stringify(x)).join('\\n')+'\\n');records.forEach(x=>emit({type:'action',...x}));
emit({type:'done',status:'completed',actions:4,modelCalls:0,cleanupConfirmed:true});
}else if(m.type==='cancel'){emit({type:'done',status:'cancelled',cleanupConfirmed:true});lines.close();process.stdin.destroy();}});
`, { mode: 0o700 });
  runtime.browserPython = python;
}
runtime.modelRuntime = modelRuntime;
const contract = {
  mode: "complete", goal: "Open the target URL, confirm fixture-reviewer. Fill Filter with Beta. Confirm only the Beta row remains visible. Click Detail in the Beta row exactly once. Observe Beta · ready and finish successfully. Do not click Alpha.",
  role: "reviewer", identity: { selector: '[data-testid="identity"]', text: "fixture-reviewer" },
  expected: [{ id: "filter-detail", text: "筛选 Beta 后仅 Beta 可见，详情结果与该行 Beta 一致。", source: { kind: "user", reference: "受控夹具验收约定：已知 Alpha/Beta 数据，仅查看 Beta。" } }],
  initialState: "全新上下文；受控夹具固定 Alpha 和 Beta，两行可重新定位。", dataStrategy: "read-only", cleanup: "none",
  completionTexts: ["Beta · ready"],
  controls: [{ action: "input", role: "textbox", name: "Filter", values: ["Beta"] },
    { action: "click", role: "button", name: "Detail", ancestor: { attributes: { "data-row": "Beta" } } }],
  provider: real ? "qwen3.8-flash-next" : "fixture", modelId: real ? "qwen3.8-flash-next" : "fixture-model",
  budget: { maxSteps: 8, timeoutMs: 180000 },
};
const settingsManager = SettingsManager.inMemory();
const resourceLoader = new DefaultResourceLoader({ cwd: workspace, agentDir, settingsManager,
  noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
  extensionFactories: [{ name: "readonly-development", factory: createReadOnlyWorkflowExtension(runtime) }],
});
await resourceLoader.reload();
const model = modelRuntime.getModel(contract.provider, contract.modelId);
assert.ok(model, "指定模型必须已登记");
const { session } = await createAgentSession({ cwd: workspace, agentDir, modelRuntime, model, settingsManager, resourceLoader, sessionManager: SessionManager.inMemory(workspace) });
let calls = 0;
const call = async (name, params, signal) => {
  const tool = session.agent.state.tools.find((item) => item.name === name);
  assert.ok(tool, `官方 SDK 必须登记 ${name}`);
  const result = await tool.execute(`check-${++calls}`, params, signal);
  assert.ok(!result.isError, JSON.stringify(result));
  return result.details;
};
const evidence = { scenario, workspace, checks: [], startedAt: new Date().toISOString(), model: `${contract.provider}/${contract.modelId}` };
try {
  const names = session.getAllTools().filter((item) => item.name.startsWith("qa_ui_")).map((item) => item.name).sort();
  assert.deepEqual(names, ["qa_ui_explore", "qa_ui_publish", "qa_ui_run", "qa_ui_save_candidate"].sort());
  evidence.checks.push("官方 SDK 登记四个工具，无旧工具");
  const explored = await call("qa_ui_explore", { targetUrl: url, contract });
  assert.equal(explored.status, "completed");
  assert.equal(await fs.stat(path.join(workspace, "qa/data")).catch(() => null), null, "新链路不得创建旧目录");
  evidence.taskId = explored.taskId;
  const taskDir = path.join(workspace, "qa/ui/tasks", explored.taskId);
  const records = (await fs.readFile(path.join(taskDir, "actions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
  const inputStep = records.find((item) => item.action.input);
  const clickStep = records.find((item) => item.action.click);
  assert.ok(inputStep && clickStep, "探索必须包含筛选和详情动作");
  const caseId = "beta-detail";
  const draft = path.join(taskDir, "drafts", caseId);
  await fs.mkdir(draft);
  const script = `const { test, expect } = require("@playwright/test");
test("filter and detail agree", async ({ page }, testInfo) => {
  await page.goto(process.env.QA_TARGET_URL);
  await expect(page.getByTestId("identity")).toHaveText("fixture-reviewer");
  await expect(page.getByRole("row")).toHaveCount(2);
  const initial = testInfo.outputPath("initial.png");
  await page.screenshot({ path: initial });
  await testInfo.attach("qa-initial-state", { path: initial, contentType: "image/png" });
  await page.getByRole("textbox", { name: "Filter", exact: true }).fill("Beta");
  const beta = page.locator('tr[data-row="Beta"]');
  await expect(beta).toBeVisible();
  await expect(page.locator('tr[data-row="Alpha"]')).toBeHidden();
  await expect(page.locator("tr:visible")).toHaveCount(1);
  await beta.getByRole("button", { name: "Detail", exact: true }).click();
  await expect(page.getByRole("status")).toHaveText("Beta · ready");
  const business = testInfo.outputPath("business.png");
  await page.screenshot({ path: business });
  await testInfo.attach("qa-business-result", { path: business, contentType: "image/png" });
});\n`;
  const metadata = { schema: "qa-ui-case/v1", caseId, taskId: explored.taskId, project: { id: "fixture", name: "Fixture" },
    title: "筛选与详情一致性", modulePath: ["Accounts"], targetUrl: url, role: contract.role,
    initialState: contract.initialState, dataStrategy: contract.dataStrategy, cleanup: contract.cleanup, expected: contract.expected,
    steps: [{ text: "输入 Beta 筛选", stepId: inputStep.stepId }, { text: "查看 Beta 详情", stepId: clickStep.stepId }],
    assertions: [{ kind: "business", expectedId: "filter-detail", text: "仅 Beta 可见且详情为 Beta · ready" }] };
  await fs.writeFile(path.join(draft, "case.spec.cjs"), script);
  await write(path.join(draft, "case.json"), metadata);
  const api = createReadOnlyWorkflow(runtime);
  if (!real) {
    const invalid = structuredClone(metadata); invalid.expected[0].text = "changed expectation";
    await write(path.join(draft, "case.json"), invalid);
    await assert.rejects(api.saveCandidate(workspace, { taskId: explored.taskId, caseId }), /预期/);
    invalid.expected = contract.expected; invalid.steps[0].stepId = "invented";
    await write(path.join(draft, "case.json"), invalid);
    await assert.rejects(api.saveCandidate(workspace, { taskId: explored.taskId, caseId }), /真实成功步骤/);
    await write(path.join(draft, "case.json"), metadata);
    await fs.writeFile(path.join(draft, "case.spec.cjs"), script.replace('test("', 'test.skip("'));
    await assert.rejects(api.saveCandidate(workspace, { taskId: explored.taskId, caseId }));
    await fs.writeFile(path.join(draft, "case.spec.cjs"), script);
    evidence.checks.push("拒绝预期漂移、虚构步骤、跳过测试");
  }
  const candidate = await call("qa_ui_save_candidate", { taskId: explored.taskId, caseId });
  assert.equal(candidate.revision, "0001");
  const selection = { caseId, revision: candidate.revision };
  await assert.rejects(api.run(workspace, { ...selection, mode: "regression" }), /正式版本/);
  evidence.checks.push("候选不能回归");
  const result = await call("qa_ui_run", { ...selection, mode: "validate" });
  assert.equal(result.status, "passed", JSON.stringify((await read(result.summaryFile)).problems));
  evidence.runId = result.runId;
  await assert.rejects(api.run(workspace, { ...selection, mode: "validate" }), /已有定向验证/);
  const summary = await read(result.summaryFile);
  assert.equal(summary.workflow, "browser-use-playwright");
  assert.equal(summary.testCount, 1);
  assert.equal(summary.cleanup, "deleted");
  const published = await call("qa_ui_publish", { ...selection, runId: result.runId });
  assert.equal(published.status, "verified");
  const assetFile = path.join(workspace, "qa/ui/cases", caseId, "asset.json");
  assert.equal((await read(assetFile)).currentRevision, "0001");
  const regression = await call("qa_ui_run", { ...selection, mode: "regression" });
  assert.equal(regression.status, "passed");
  evidence.checks.push("独立上下文筛选详情通过、发布、正式回归通过，验证批次不重复启动");
  if (!real) {
    const manifestFile = path.join(workspace, "qa/ui/runs", result.runId, "manifest.json");
    const manifest = await read(manifestFile);
    const original = await fs.readFile(result.summaryFile);
    const changed = { ...summary, status: "failed", exitCode: 1 };
    await write(result.summaryFile, changed);
    await assert.rejects(api.publish(workspace, { ...selection, runId: result.runId }), /已变更/);
    // 负例：即使清单与失败报告一致，也不能以有报告为由发布。
    const failedData = await fs.readFile(result.summaryFile);
    const fileEntry = manifest.files.find((item) => item.path === "summary.json");
    fileEntry.bytes = failedData.length; fileEntry.sha256 = createHash("sha256").update(failedData).digest("hex");
    await write(manifestFile, manifest);
    await assert.rejects(api.publish(workspace, { ...selection, runId: result.runId }), /实际 passed/);
    await fs.writeFile(result.summaryFile, original);
    const frozen = path.join(workspace, "qa/ui/cases", caseId, "revisions/0001/case.spec.cjs");
    await fs.appendFile(frozen, "// changed\n");
    await assert.rejects(api.publish(workspace, { ...selection, runId: result.runId }), /revision 文件已变更/);
    assert.equal((await read(assetFile)).currentRevision, "0001");
    evidence.checks.push("拒绝报告篡改、真实失败、版本变动；正式引用保留");
    // 同一工作区第二实例不能穿透文件锁；取消不等待锁。
    const controller = new AbortController();
    let cancelReady;
    const ready = new Promise((resolve) => { cancelReady = resolve; });
    const pending = api.explore(workspace, { targetUrl: url, contract: { ...contract, goal: "cancel-fixture" } }, controller.signal,
      (event) => { if (event.phase === "browser-ready") cancelReady(); });
    await ready;
    await assert.rejects(createReadOnlyWorkflow(runtime).explore(workspace, { targetUrl: url, contract }), /已有 UI 任务/);
    controller.abort();
    const cancelled = await pending;
    assert.equal(cancelled.status, "cancelled");
    const cancelledTask = await read(path.join(workspace, "qa/ui/tasks", cancelled.taskId, "task.json"));
    assert.equal(cancelledTask.terminal.cleanupConfirmed, true);
    evidence.checks.push("跨实例互斥、取消终值与收尾");
    const outside = path.join(base, "outside"); await fs.mkdir(outside);
    const escapeCase = path.join(taskDir, "drafts", "escape"); await fs.symlink(outside, escapeCase);
    await assert.rejects(api.saveCandidate(workspace, { taskId: explored.taskId, caseId: "escape" }), /符号链接/);
    evidence.checks.push("拒绝草稿目录链接越界");
    await assert.rejects(api.explore(workspace, { targetUrl: url, contract: { ...contract, goal: "unknown-fixture" } }), /探索未完成/);
    await fs.access(path.join(workspace, "qa/ui/.workflow.lock"));
    await assert.rejects(api.explore(workspace, { targetUrl: url, contract }), /已有 UI 任务/);
    evidence.checks.push("收尾未知保留互斥标记，拒绝新任务");
  }
  assert.ok(requests.length >= 2 && requests.every((item) => item === "Beta"), JSON.stringify(requests));
  const privateFiles = await fs.readdir(taskDir);
  assert.ok(!privateFiles.includes("private"));
  evidence.requests = requests;
  evidence.status = "passed";
} finally {
  evidence.finishedAt = new Date().toISOString();
  await write(path.join(base, "check-summary.json"), evidence);
  await lifecycle.closePiSession(session);
  await new Promise((resolve) => server.close(resolve));
}
process.stdout.write(JSON.stringify(evidence) + "\n");
