import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createReadOnlyWorkflow } from "../../src/main/capabilities/ui-testing/workflow.mjs";
import { validateApprovalStep } from "../../src/main/capabilities/ui-testing/approval.mjs";
import paths from "../../src/main/capabilities/ui-testing/runtime-paths.js";

const [base] = process.argv.slice(2);
const workspace = path.join(base, "审批 workspace");
await fs.mkdir(workspace);
const read = async file => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, data) => fs.writeFile(file, JSON.stringify(data));
const password = "isolated-fixture-password";
process.env.QA_UI_TEST_PASSWORD = password;
const records = new Map(), writes = [];
let hideStatus = false, onApprove;
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  const account = req.headers.cookie?.match(/actor=(\w+)/)?.[1];
  let body = "";
  for await (const chunk of req) body += chunk.toString();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (req.method === "POST" && url.pathname === "/login") {
    const data = new URLSearchParams(body);
    assert.equal(data.get("password"), password);
    res.setHeader("Set-Cookie", `actor=${data.get("username")}; Path=/; HttpOnly; SameSite=Lax`);
    res.writeHead(302, { Location: url.searchParams.get("next") }); res.end(); return;
  }
  if (!account) {
    res.end(`<form method="post" action="/login?next=${encodeURIComponent(req.url)}"><input name="username"><input name="password" type="password"><button>登录</button></form>`); return;
  }
  if (req.method === "POST") {
    if (url.pathname === "/create") {
      assert.equal(account, "creator");
      const id = String(records.size + 1), name = new URLSearchParams(body).get("name");
      records.set(id, { name, status: "review", uploaded: false });
      writes.push({ id, account, action: "create" });
      res.setHeader("Content-Type", "application/json");res.end(JSON.stringify({ id })); return;
    }
    const id = url.searchParams.get("id"), record = records.get(id);
    if (url.pathname === "/upload") {
      assert.equal(account, "chairman"); assert.ok(body.includes("fixture attachment"));
      record.uploaded = true; writes.push({ id, account, action: "upload" });
    } else {
      assert.equal(account, record.status === "review" ? "reviewer" : "chairman");
      if (account === "chairman") assert.equal(record.uploaded, true);
      record.status = account === "reviewer" ? "chairman" : "done";
      writes.push({ id, account, action: "approve" });
      onApprove?.();
    }
    res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ status: record.status })); return;
  }
  const record = records.get(url.searchParams.get("id"));
  const header = `<p id="identity">${account}</p>`;
  if (url.pathname === "/new") {
    res.end(header + `<p id="status">new</p><input id="name"><button id="create">创建</button><script>
create.onclick=async()=>{const r=await(await fetch('/create',{method:'POST',body:new URLSearchParams({name:document.querySelector('#name').value})})).json();location.href='/record?id='+r.id;};</script>`); return;
  }
  if (!record) { res.end(header + '<p id="status">missing</p>'); return; }
  res.end(header + `<p id="name">${record.name}</p><p id="status">${hideStatus ? "pending-display" : record.status}</p><p id="uploaded">${record.uploaded}</p>
<input id="attachment" type="file"><button id="upload">上传</button><input id="opinion"><button id="approve">同意</button><script>
upload.onclick=async()=>{const data=new FormData();data.append('file',document.querySelector('#attachment').files[0]);await fetch('/upload'+location.search,{method:'POST',body:data});document.querySelector('#uploaded').textContent='true';};
approve.onclick=async()=>{const r=await(await fetch('/approve'+location.search,{method:'POST'})).json();document.querySelector('#status').textContent=${hideStatus ? "'pending-display'" : "r.status"};};</script>`);
});
server.listen(0, "127.0.0.1"); await once(server, "listening");
const origin = `http://127.0.0.1:${server.address().port}`;
const runtime = { ...paths.resolveUiTestingRuntime({ isPackaged: false }, path.resolve(import.meta.dirname, "../..")), projectConfig: path.join(base, "projects.json") };
await write(runtime.projectConfig, { projects: [{ id: "fixture", name: "Fixture", workspaceDir: workspace, address: origin, account: "creator", password }] });
const api = createReadOnlyWorkflow(runtime);
const auth = { kind: "user", reference: "isolated approval fixture" };
const config = { source: "fixture-flow", record: { selector: "#name", text: "qa-{{runId}}" }, residualAuthorization: auth,
  actors: ["creator", "reviewer", "chairman"].map(account => ({ id: account, account, source: "fixture-mapping", credentialSource: account === "creator" ? "project" : "test-password", identity: { selector: "#identity", text: account } })) };
const create = { id: "create", name: "创建提交", source: "fixture-rule", actorId: "creator", url: origin + "/new", createsRecord: true,
  before: [{ selector: "#status", text: "new" }], after: [{ selector: "#status", text: "review" }], capture: { name: "recordId", query: "id" },
  actions: [{ kind: "fill", selector: "#name", value: "qa-{{runId}}" }, { kind: "click", selector: "#create" }] };
const review = { id: "review", name: "部门审核", source: "fixture-rule", actorId: "reviewer", url: origin + "/record?id={{recordId}}",
  before: [{ selector: "#status", text: "review" }], after: [{ selector: "#status", text: "chairman" }],
  actions: [{ kind: "fill", selector: "#opinion", value: "同意" }, { kind: "click", selector: "#approve" }] };
const finish = { id: "finish", name: "董事长审核", source: "fixture-rule", actorId: "chairman", url: review.url,
  before: [{ selector: "#status", text: "chairman" }], after: [{ selector: "#status", text: "done" }], terminal: true,
  actions: [{ kind: "upload", selector: "#attachment", file: "attachment.txt" }, { kind: "click", selector: "#upload" }, { kind: "click", selector: "#approve" }] };
await fs.writeFile(path.join(workspace, "attachment.txt"), "fixture attachment");
const inspect = (flowId, conf = config, step = { actorId: "creator", url: create.url }) => api.approval(workspace, { operation: "inspect", flowId, projectId: "fixture", targetUrl: create.url, config: conf, step });
const execute = (flowId, step, previousStepId) => api.approval(workspace, { operation: "execute", flowId, step, previousStepId, authorization: auth });
let evidence;
try {
  const instructions = await api.approval(workspace, { operation: "instructions" });
  assert.match(instructions.instructions, /审批探索与完整链测试/);
  const dynamicDir = path.join(base, "runtime", "prompt"); await fs.mkdir(dynamicDir, { recursive: true });
  await fs.cp(path.join(runtime.directory, "browser-use"), path.join(path.dirname(dynamicDir), "browser-use"), { recursive: true, filter: file => !file.includes(".venv") && !file.includes("__pycache__") });
  const dynamic = createReadOnlyWorkflow({ ...runtime, directory: path.dirname(dynamicDir) });
  await assert.rejects(dynamic.approval(workspace, { operation: "instructions" }), { code: "ENOENT" });
  await fs.writeFile(path.join(dynamicDir, "approval-control.md"), "本轮动态规则");
  assert.equal((await dynamic.approval(workspace, { operation: "instructions" })).instructions, "本轮动态规则");
  assert.throws(() => validateApprovalStep({ ...create, password: "not-allowed" }, { address: origin, actors: config.actors }), /未支持字段/);
  const preview = await inspect("full-chain"); assert.equal(preview.status, "completed"); assert.ok(preview.controls.some(item => item.id === "create"));
  assert.equal(writes.length, 0, "inspect 不写业务");
  assert.equal((await execute("full-chain", create)).status, "completed");
  assert.equal((await execute("full-chain", review, "create")).status, "completed");
  assert.equal((await execute("full-chain", finish, "review")).terminal, true);
  assert.equal(writes.length, 4);
  await assert.rejects(execute("full-chain", finish, "review"), /禁止重复执行/);
  const contract = { mode: "complete", role: "approval-workflow", identity: config.actors[0].identity,
    goal: "完整审批链", expected: [{ id: "terminal", text: "done", source: { kind: "rule", reference: "fixture-rule" } }],
    initialState: "全新记录", dataStrategy: "isolated-write", cleanup: "residual", writeAuthorization: auth, residualAuthorization: auth,
    controls: [{ action: "click", attributes: { id: "create" } }], completionTexts: ["done"], provider: "fixture", modelId: "offline", budget: { maxSteps: 12, timeoutMs: 180000 } };
  await assert.rejects(api.approval(workspace, { operation: "candidate", flowId: "full-chain", caseId: "chain", title: "完整审批", modulePath: ["Fixture"], contract: { ...contract, expected: [{ ...contract.expected[0], text: "invented" }] } }), /真实 after 断言/);
  const draft = await api.approval(workspace, { operation: "candidate", flowId: "full-chain", caseId: "chain", title: "完整审批", modulePath: ["Fixture"], contract });
  const saved = await api.saveCandidate(workspace, { taskId: draft.taskId, caseId: "chain" });
  const result = await api.run(workspace, { caseId: "chain", revision: saved.revision, mode: "validate" });
  assert.equal(result.status, "passed", JSON.stringify(await read(result.summaryFile)));
  await api.publish(workspace, { caseId: "chain", revision: saved.revision, runId: result.runId });
  const regression = await api.run(workspace, { caseId: "chain", revision: saved.revision, mode: "regression" });
  assert.equal(regression.status, "passed");
  assert.equal(records.size, 3, "探索、验证、回归各自创建独立记录");
  assert.equal(new Set([...records.values()].map(item => item.name)).size, 3);
  assert.ok([...records.values()].every(item => item.status === "done" && item.uploaded));
  const manifest = await read(path.join(path.dirname(result.summaryFile), "manifest.json"));
  assert.equal((await read(result.summaryFile)).tracePolicy, "disabled-for-private-auth");
  assert.ok(!manifest.files.some(item => item.path.endsWith("trace.zip")));
  await fs.writeFile(path.join(workspace, "attachment.txt"), "changed");
  await assert.rejects(api.run(workspace, { caseId: "chain", revision: saved.revision, mode: "regression" }), /附件已变化/);
  await fs.writeFile(path.join(workspace, "attachment.txt"), "fixture attachment");
  const wrong = structuredClone(config); wrong.actors[0].identity.text = "other-user";
  await assert.rejects(inspect("wrong-identity", wrong), /身份核验未通过/);
  assert.equal(records.size, 3, "错误身份未写入");
  await inspect("uncertain");
  await execute("uncertain", create);
  hideStatus = true;
  // before 使用节点创建后已核实的 record，模拟提交生效但结果区未刷新的故障。
  const uncertain = { ...review, before: [{ selector: "#name", text: "qa-{{runId}}" }] };
  const unknown = await execute("uncertain", uncertain, "create");
  assert.equal(unknown.status, "unknown");
  const count = writes.length; hideStatus = false;
  assert.equal((await api.approval(workspace, { operation: "reconcile", flowId: "uncertain" })).status, "completed");
  assert.equal(writes.length, count, "reconcile 只核对，不重交");
  await assert.rejects(execute("uncertain", uncertain, "create"), /禁止重复执行/);
  await inspect("cancelled-node");
  await execute("cancelled-node", create);
  const controller = new AbortController();
  onApprove = () => { onApprove = undefined; controller.abort(); };
  const cancelled = await api.approval(workspace, { operation: "execute", flowId: "cancelled-node", previousStepId: "create", authorization: auth,
    step: { ...review, actions: [...review.actions, { kind: "fill", selector: "#never-rendered", value: "unused" }] } }, controller.signal);
  assert.equal(cancelled.status, "unknown");
  const afterCancel = writes.length;
  assert.equal((await api.approval(workspace, { operation: "reconcile", flowId: "cancelled-node" })).status, "completed");
  assert.equal(writes.length, afterCancel, "取消后只读核对，不补交");
  // 创建已生效、最终状态暂时未显示；用真实记录 URL 只读恢复 capture，不重新创建。
  await inspect("uncertain-create"); hideStatus = true;
  const createdUnknown = await execute("uncertain-create", create);
  assert.equal(createdUnknown.status, "unknown"); hideStatus = false;
  const createdId = String(records.size), afterCreate = writes.length;
  const recoveredCreate = await api.approval(workspace, { operation: "reconcile", flowId: "uncertain-create", targetUrl: origin + "/record?id=" + createdId });
  assert.equal(recoveredCreate.variables.recordId, createdId);
  assert.equal(writes.length, afterCreate, "未知创建沿原记录恢复，不新建");
  assert.ok((await fs.readdir(workspace)).every(name => !name.startsWith("qa-ui-auth")));
  for (const entry of await fs.readdir(path.join(workspace, "qa/ui/runs"))) {
    const task = await read(path.join(workspace, "qa/ui/runs", entry, "task.json"));
    if (task.authDirectory) await assert.rejects(fs.access(task.authDirectory), { code: "ENOENT" });
  }
  evidence = { status: "passed", checks: ["动态加载", "三账号身份隔离", "完整节点与真实上传", "冻结候选及独立验证发布回归", "每批独立记录", "拒绝重复/错误身份/附件变化", "结果未知只读核对", "取消与未知创建恢复"], records: records.size, writes: writes.length, runId: result.runId };
  await write(path.join(base, "check-summary.json"), evidence);
} finally { await new Promise(resolve => server.close(resolve)); }
process.stdout.write(JSON.stringify(evidence) + "\n");
