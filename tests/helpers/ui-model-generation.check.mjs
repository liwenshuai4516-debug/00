import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import http from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import {
  ModelRuntime,
  DefaultResourceLoader,
  SettingsManager,
  SessionManager,
  createAgentSession,
} from "@mariozechner/pi-coding-agent";
import { createUiTestingExtension } from "../../src/main/capabilities/ui-testing/extension.mjs";
import { createReadOnlyWorkflow } from "../../src/main/capabilities/ui-testing/workflow.mjs";
import paths from "../../src/main/capabilities/ui-testing/runtime-paths.js";
import lifecycle from "../../src/main/resources/pi-session-lifecycle.js";

// 真实模型生成候选与补丁的受控验收：受控本地页面、隔离临时工作区、真实模型会话。
// 本脚本不读取凭据正文，只使用本机已登记的 qwen3.8-flash-next 模型。
const [baseArg, scenario = "all"] = process.argv.slice(2);
assert.ok(baseArg, "用法：node tests/helpers/ui-model-generation.check.mjs <证据目录> [setup|all|repair]");
const base = path.resolve(baseArg);
const real = scenario !== "setup";
const repairOnly = scenario === "repair";
const provider = "qwen3.8-flash-next";
const modelId = "qwen3.8-flash-next";
const caseId = "beta-detail";
const workspace = path.join(base, "只读 workspace ' model");
const agentDir = path.join(base, "agent");
await fs.mkdir(workspace, { recursive: true });
await fs.mkdir(agentDir, { recursive: true });
const read = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const write = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2));
const sha = (data) => createHash("sha256").update(data).digest("hex");

// 受控页面在候选和失败阶段保持同一业务结构与文本，仅详情响应时间可调。
let detailDelayMs = 100;
const app = () => `<!doctype html><html lang="en"><head><title>Model generation fixture</title></head><body>
<h1>Accounts</h1><p data-testid="identity">fixture-reviewer</p>
<label>Filter<input aria-label="Filter" data-testid="filter"></label>
<table><tbody><tr data-row="Alpha"><td>Alpha</td><td><button>Detail</button></td></tr>
<tr data-row="Beta"><td>Beta</td><td><button>Detail</button></td></tr></tbody></table>
<p role="status">No detail selected</p><script>
document.querySelector('input').oninput=e=>document.querySelectorAll('tr').forEach(row=>row.hidden=!row.getAttribute('data-row').includes(e.target.value));
document.querySelectorAll('button').forEach(button=>button.onclick=async()=>{
 document.querySelector('[role="status"]').textContent='Loading';
 const data=await(await fetch('/detail?id='+button.closest('tr').getAttribute('data-row'))).json();
 document.querySelector('[role="status"]').textContent=data.text;
});</script></body></html>`;
const requests = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  if (url.pathname === "/detail") {
    requests.push(url.searchParams.get("id"));
    setTimeout(() => {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ text: `${url.searchParams.get("id")} · ready` }));
    }, detailDelayMs);
  } else {
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "no-store");
    res.end(app());
  }
});
const existingProjects = repairOnly ? await read(path.join(base, "projects.json")) : null;
const listenPort = existingProjects ? Number(new URL(existingProjects.projects[0].address).port) : 0;
server.listen(listenPort, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/`;
const runtime = {
  ...paths.resolveUiTestingRuntime({ isPackaged: false }, path.resolve(import.meta.dirname, "../..")),
  projectConfig: path.join(base, "projects.json"),
};
await write(runtime.projectConfig, { projects: [{ id: "fixture", name: "Fixture", workspaceDir: workspace, address: url }] });

const contract = {
  mode: "complete",
  goal: "Open the target URL, confirm fixture-reviewer. Fill Filter with Beta. Confirm only the Beta row remains visible. Click Detail in the Beta row exactly once. Observe Beta · ready and finish successfully. Do not click Alpha.",
  role: "reviewer",
  identity: { selector: '[data-testid="identity"]', text: "fixture-reviewer" },
  expected: [{ id: "filter-detail", text: "筛选 Beta 后仅 Beta 可见，详情结果与该行 Beta 一致。", source: { kind: "user", reference: "受控夹具验收约定：已知 Alpha/Beta 数据，仅查看 Beta。" } }],
  initialState: "全新上下文；受控夹具固定 Alpha 和 Beta，两行可重新定位。",
  dataStrategy: "read-only",
  cleanup: "none",
  completionTexts: ["Beta · ready"],
  controls: [
    { action: "input", role: "textbox", name: "Filter", values: ["Beta"] },
    { action: "click", role: "button", name: "Detail", ancestor: { attributes: { "data-row": "Beta" } } },
  ],
  provider,
  modelId,
  budget: { maxSteps: 8, timeoutMs: 180000 },
};

const evidence = {
  scenario,
  workspace,
  model: `${provider}/${modelId}`,
  checks: [],
  phases: {},
  startedAt: new Date().toISOString(),
};
let session;
let modelRuntime;
const events = [];
let phase = "setup";
const activeToolCalls = new Map();
let promptTimedOut = false;

function summarizeArgs(args) {
  if (!args || typeof args !== "object") return args;
  const output = {};
  for (const [key, value] of Object.entries(args)) {
    if (typeof value === "string") output[key] = value.length > 240 ? `${value.slice(0, 240)}…(${value.length} chars)` : value;
    else if (key === "edits" && Array.isArray(value)) output[key] = { count: value.length };
    else output[key] = value;
  }
  return output;
}

try {
  modelRuntime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const selected = modelRuntime.getModel(provider, modelId);
  assert.ok(selected, "指定模型必须已在本机登记");
  assert.equal(selected.api, "openai-completions");
  const settingsManager = SettingsManager.inMemory();
  const resourceLoader = new DefaultResourceLoader({
    cwd: workspace,
    agentDir,
    settingsManager,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    appendSystemPrompt: ["你在执行受控 UI 测试验收。必须实际调用工具完成任务，不要只输出计划；不能读取或输出任何凭据正文。"],
    extensionFactories: [{ name: "desktop-ui-testing", factory: createUiTestingExtension(runtime) }],
  });
  await resourceLoader.reload();
  runtime.modelRuntime = modelRuntime;
  const { session: created } = await createAgentSession({
    cwd: workspace,
    agentDir,
    modelRuntime,
    model: modelRuntime.getModel(provider, modelId),
    thinkingLevel: "off",
    settingsManager,
    resourceLoader,
    sessionManager: SessionManager.inMemory(workspace),
  });
  session = created;
  await session.bindExtensions({ mode: "json", onError: (error) => events.push({ type: "extension_error", phase, error: error?.message ?? String(error) }) });
  const skills = session.resourceLoader.getSkills().skills.map((item) => item.name);
  assert.ok(skills.includes("qa-ui-basic"), "必须加载 qa-ui-basic 技能");
  evidence.skills = skills;
  evidence.checks.push("加载 qa-ui-basic 技能与四工具扩展");
  if (!real) throw { setupOnly: true };
  const toolNames = session.getAllTools().map((item) => item.name);
  for (const name of ["qa_ui_explore", "qa_ui_save_candidate", "qa_ui_run", "qa_ui_publish", "read", "write", "edit", "bash"]) {
    assert.ok(toolNames.includes(name), `会话必须登记 ${name}`);
  }
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      activeToolCalls.set(event.toolCallId, { phase, toolName: event.toolName });
      events.push({ type: "tool_start", phase, toolName: event.toolName, toolCallId: event.toolCallId, args: summarizeArgs(event.args) });
    } else if (event.type === "tool_execution_end") {
      events.push({ type: "tool_end", phase, toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError, durationMs: event.durationMs });
    } else if (event.type === "message_end") {
      const message = event.message;
      if (message?.role === "assistant") {
        events.push({ type: "assistant", phase, model: message.model ?? null, stopReason: message.stopReason ?? null,
          usage: message.usage ? { input: message.usage.input, output: message.usage.output, totalTokens: message.usage.totalTokens } : null });
      }
    } else if (["auto_retry_start", "auto_retry_end", "agent_settled"].includes(event.type)) {
      events.push({ type: event.type, phase, attempt: event.attempt, willRetry: event.willRetry, aborted: event.aborted });
    }
  });

  async function ask(label, text, timeoutMs) {
    promptTimedOut = false;
    const timer = setTimeout(() => {
      promptTimedOut = true;
      void session.abort().catch(() => {});
    }, timeoutMs);
    const startedAt = new Date().toISOString();
    const before = events.length;
    try {
      await session.prompt(text);
    } finally {
      clearTimeout(timer);
    }
    const slice = events.slice(before);
    const assistantMessages = slice.filter((item) => item.type === "assistant");
    const phaseEvidence = {
      startedAt,
      finishedAt: new Date().toISOString(),
      prompt: text.length > 2000 ? `${text.slice(0, 2000)}…(${text.length} chars)` : text,
      assistantMessages: assistantMessages.length,
      usage: assistantMessages.map((item) => item.usage).filter(Boolean),
      tools: slice.filter((item) => item.type === "tool_start").map((item) => ({ toolName: item.toolName, args: item.args })),
      toolErrors: slice.filter((item) => item.type === "tool_end" && item.isError).map((item) => item.toolName),
    };
    evidence.phases[label] = phaseEvidence;
    if (promptTimedOut) throw new Error(`${label}：模型调用超过 ${timeoutMs} ms，已请求中止`);
    return phaseEvidence;
  }

  // 阶段一：真实模型自行探索、写候选、静态保存、独立验证并发布。
  let task;
  let taskDir;
  let draftDir;
  let scriptText;
  let assetFile;
  let asset;
  const inDirectory = (value, directory) => {
    if (typeof value !== "string") return false;
    const resolved = path.isAbsolute(value) ? value : path.resolve(workspace, value);
    return resolved.startsWith(path.resolve(directory));
  };
  if (!repairOnly) {
    phase = "candidate";
    const explorationTask = `请完成一条受控只读 UI 用例的真实完整测试，从探索到发布。不要只说明计划。

  项目：fixture（Fixture）；目标地址：${url}
  业务预期（必须原样冻结）：
  ${JSON.stringify(contract.expected, null, 2)}
  初态：${contract.initialState}
  完成信号：${JSON.stringify(contract.completionTexts)}
  允许控件：
  ${JSON.stringify(contract.controls, null, 2)}
  模型：provider=${provider}，modelId=${modelId}（必须原样）
  预算：maxSteps=${contract.budget.maxSteps}，timeoutMs=${contract.budget.timeoutMs}
  caseId：${caseId}

  先用 qa_ui_explore 完成 mode=complete 的真实探索，targetUrl=${url}，contract 使用下面 JSON 原样（字段和值都不得改写）：
  ${JSON.stringify(contract, null, 2)}

  探索完成后按 qa-ui-basic：
  1. 读取返回 taskDirectory 下的 actions.jsonl。case.json 的 steps 必须引用其中真实成功（没有 error）的 stepId。
  2. 用 write 工具在 taskDirectory/drafts/${caseId}/ 直接创建 case.spec.cjs 与 case.json，不要用 bash 拼文件。case.json 的 expected 必须与 contract 完全一致，不得出现 writeAuthorization。
  3. 脚本要求：
     - 只使用 const { test, expect } = require("@playwright/test")，只有一条 test。
     - 打开 process.env.QA_TARGET_URL；先用 [data-testid="identity"] 核对 fixture-reviewer，并确认初始表里 Alpha、Beta 两行。
     - 截图保存到 testInfo.outputPath 后 attach 名称 qa-initial-state（image/png）。
     - 用 Filter 输入 Beta；断言 Beta 行可见、Alpha 行不可见，并断言当前只有 1 行可见，避免空集合通过。
     - 点击 Beta 行的 Detail；断言状态文本 Beta · ready。
     - 业务结果截图保存到 testInfo.outputPath 后 attach 名称 qa-business-result（image/png）。
     - 不使用 skip、only、nth、first、last、waitForTimeout、setTimeout、while、catch；不写任何凭据或密码。
  4. 调用 qa_ui_save_candidate({taskId, caseId:"${caseId}"}) 冻结候选。
  5. 调用 qa_ui_run({caseId:"${caseId}", revision, mode:"validate"})；只有 passed 才调用 qa_ui_publish({caseId, revision, runId})。
  6. 最后输出一行 JSON：{"taskId":"...","caseId":"${caseId}","revision":"...","runId":"...","status":"verified"}。任何一步失败就报告实际错误并停止，不重复同一调用。
  `;
    await ask("candidate", `/skill:qa-ui-basic ${explorationTask}`, 10 * 60 * 1000).catch((error) => { throw new Error(`候选阶段失败：${error.message}`); });

    const taskDirs = (await fs.readdir(path.join(workspace, "qa/ui/tasks"), { withFileTypes: true }))
      .filter((item) => item.isDirectory() && item.name.startsWith("task-")).map((item) => item.name);
    assert.ok(taskDirs.length >= 1, "必须产生探索任务目录");
    for (const name of taskDirs) {
      const candidate = await read(path.join(workspace, "qa/ui/tasks", name, "task.json"));
      if (candidate.status === "completed") task = candidate;
    }
    assert.ok(task, "探索任务必须 completed");
    assert.equal(task.kind, undefined, "候选阶段必须是新建任务");
    evidence.candidate = { taskId: task.taskId, actions: task.terminal?.actions, modelCalls: task.terminal?.modelCalls };
    assetFile = path.join(workspace, "qa/ui/cases", caseId, "asset.json");
    asset = await read(assetFile);
    assert.equal(asset.currentRevision, "0001");
    assert.equal(asset.revisions.length, 1);
    taskDir = path.join(workspace, "qa/ui/tasks", task.taskId);
    draftDir = path.join(taskDir, "drafts", caseId);
    const revisionDir = path.join(workspace, "qa/ui/cases", caseId, "revisions/0001");
    const draftScript = await fs.readFile(path.join(draftDir, "case.spec.cjs"));
    const revisionScript = await fs.readFile(path.join(revisionDir, "case.spec.cjs"));
    assert.equal(sha(draftScript), sha(revisionScript), "发布版本必须来自模型写入的草稿");
    const draftMeta = await fs.readFile(path.join(draftDir, "case.json"));
    assert.equal(sha(draftMeta), sha(await fs.readFile(path.join(revisionDir, "case.json"))));
    scriptText = draftScript.toString("utf8");
    assert.match(scriptText, /qa-initial-state/);
    assert.match(scriptText, /qa-business-result/);
    const writeCalls = evidence.phases.candidate.tools.filter((item) => item.toolName === "write" &&
      inDirectory(item.args?.path, draftDir));
    assert.ok(writeCalls.length >= 2, "候选脚本和说明必须由模型 write 工具写入");
    evidence.candidate.revision = "0001";
    evidence.candidate.writeCalls = writeCalls.map((item) => path.basename(item.args.path));
    evidence.candidate.scriptSha256 = sha(draftScript);
    evidence.candidate.script = scriptText;
    evidence.candidate.metadata = JSON.parse(draftMeta);
    evidence.candidate.validationRunId = asset.revisions[0].validatedRunId;
    evidence.checks.push("真实模型探索后写入候选，静态保存、定向验证和发布均成功");
    assert.equal(asset.revisions[0].validationRunId !== null, true);


  } else {
    // 修复验收复用真实模型已完成的候选，确认其来源和验证记录。
    assetFile = path.join(workspace, "qa/ui/cases", caseId, "asset.json");
    asset = await read(assetFile);
    assert.equal(asset.currentRevision, "0001", "复用的候选必须是当前正式版本");
    assert.equal(asset.revisions.length, 1);
    const entry = asset.revisions[0];
    const existingTask = await read(path.join(workspace, "qa/ui/tasks", entry.taskId, "task.json"));
    assert.equal(existingTask.status, "completed");
    assert.equal(existingTask.kind, undefined);
    task = existingTask;
    taskDir = path.join(workspace, "qa/ui/tasks", task.taskId);
    draftDir = path.join(taskDir, "drafts", caseId);
    const revisionDir = path.join(workspace, "qa/ui/cases", caseId, "revisions/0001");
    const script = await fs.readFile(path.join(revisionDir, "case.spec.cjs"));
    scriptText = script.toString("utf8");
    evidence.candidate = { taskId: task.taskId, revision: "0001", validationRunId: entry.validatedRunId,
      scriptSha256: sha(script), reusedFrom: base, script: scriptText,
      metadata: JSON.parse(await fs.readFile(path.join(revisionDir, "case.json"))) };
    evidence.checks.push("复用真实模型已完成并发布的候选开始补丁验收");
  }

  if (evidence.phases.candidate?.toolErrors?.length) {
    evidence.checks.push(`模型遇到静态校验拒绝后自主修正：${evidence.phases.candidate.toolErrors.join(", ")}`);
  }

  // 阶段二：页面详情变慢造成真实回归失败，真实模型诊断并生成补丁。
  phase = "repair";
  const explicitTimeouts = [...scriptText.matchAll(/timeout\s*:\s*(\d+)/g)].map((match) => Number(match[1]));
  const maxExplicitTimeout = explicitTimeouts.length ? Math.max(...explicitTimeouts) : 0;
  // 详情延迟必须超过脚本显式设置的断言等待，才能真正触发等待类失败。
  detailDelayMs = Math.min(25000, Math.max(13000, maxExplicitTimeout + 3000));
  // 页面只变慢，身份和业务文本保持不变，避免后台登录守卫误判。
  evidence.repair = { parentRunId: null, requestedDetailDelayMs: detailDelayMs, maxExplicitTimeout };
  const workflow = createReadOnlyWorkflow(runtime);
  const failed = await workflow.run(workspace, { caseId, revision: "0001", mode: "regression" });
  assert.equal(failed.status, "failed", `预期真实回归失败，实际 ${failed.status}`);
  const failedSummary = await read(failed.summaryFile);
  assert.equal(failedSummary.purpose, "regression");
  assert.equal(failedSummary.status, "failed");
  evidence.repair = { ...evidence.repair, parentRunId: failed.runId, failedProblems: failedSummary.problems, failedTests: failedSummary.tests?.map((item) => ({ title: item.title, status: item.status, errors: item.errors?.map((error) => error.message) })) };
  evidence.checks.push("页面详情延迟造成真实失败回归，父批次保留原报告");

  const repairTask = `执行并修复只读正式用例 ${caseId} revision 0001。真实回归批次 ${failed.runId} 已失败，失败报告在 ${failed.summaryFile}。

已确认的环境变化：详情接口响应时间从约 100 毫秒增加到约 ${Math.round(detailDelayMs / 1000)} 秒，业务文本仍为 Beta · ready；原脚本使用默认 10 秒断言超时，因此回归超时失败。页面结构和业务预期没有变化。

请按 qa-ui-basic 的“执行并修复”：
1. 读取失败 summary、当前 revision 的 case.spec.cjs 与 case.json，确认失败原因。
2. 调用 qa_ui_save_candidate({caseId:"${caseId}", baseRevision:"0001", parentRunId:"${failed.runId}"}) 建立修复任务；不要传 taskId，不启动探索。
3. 只修改脚本的定位、等待或证据：为业务结果断言设置足够但不超过 30 秒用例总超时的等待。case.json 的 expected、steps、assertions、title、modulePath 等业务字段必须原样复制，不得修改。
4. 用 write 工具把补丁脚本写到返回的 draftDirectory；case.json 也写入原样副本。然后调用 qa_ui_save_candidate({taskId, caseId:"${caseId}", patchSummary:"..."}) 保存新 revision。
5. 调用 qa_ui_run({caseId:"${caseId}", revision, mode:"validate"})；passed 才 qa_ui_publish({caseId, revision, runId})。不要重跑已失败的父批次。
6. 最后输出一行 JSON：{"taskId":"...","caseId":"${caseId}","revision":"...","runId":"...","parentRunId":"...","status":"verified"}。失败就报告实际错误并停止。
`;
  await ask("repair", `/skill:qa-ui-basic ${repairTask}`, 10 * 60 * 1000).catch((error) => { throw new Error(`补丁阶段失败：${error.message}`); });

  const repairedAsset = await read(assetFile);
  assert.equal(repairedAsset.currentRevision, "0002");
  assert.equal(repairedAsset.revisions.length, 2);
  const patchEntry = repairedAsset.revisions[1];
  assert.equal(patchEntry.baseRevision, "0001");
  assert.equal(patchEntry.parentRunId, failed.runId);
  assert.ok(patchEntry.patchSummary, "补丁必须记录摘要");
  assert.ok(patchEntry.validatedRunId, "补丁必须完成定向验证并发布");
  const repairTaskFile = path.join(workspace, "qa/ui/tasks", patchEntry.taskId, "task.json");
  const repairRecord = await read(repairTaskFile);
  assert.equal(repairRecord.kind, "repair");
  assert.equal(repairRecord.repair.parentRunId, failed.runId);
  const patchedScript = await fs.readFile(path.join(workspace, "qa/ui/cases", caseId, "revisions/0002/case.spec.cjs"), "utf8");
  const baseMeta = JSON.parse(await fs.readFile(path.join(workspace, "qa/ui/cases", caseId, "revisions/0001/case.json")));
  const patchedMeta = JSON.parse(await fs.readFile(path.join(workspace, "qa/ui/cases", caseId, "revisions/0002/case.json")));
  assert.deepEqual(patchedMeta, baseMeta, "补丁不得改变业务说明");
  assert.notEqual(sha(patchedScript), sha(scriptText), "补丁脚本必须发生变化");
  const repairWriteCalls = evidence.phases.repair.tools.filter((item) => item.toolName === "write" &&
    inDirectory(item.args?.path, path.join(workspace, "qa/ui/tasks", patchEntry.taskId, "drafts", caseId)));
  assert.ok(repairWriteCalls.length >= 2, "补丁脚本和说明必须由模型 write 工具写入");
  evidence.repair.taskId = patchEntry.taskId;
  evidence.repair.revision = "0002";
  evidence.repair.validationRunId = patchEntry.validatedRunId;
  evidence.repair.patchSummary = patchEntry.patchSummary;
  evidence.repair.scriptSha256 = sha(patchedScript);
  evidence.repair.script = patchedScript;
  evidence.checks.push("真实模型读取失败后生成最小补丁，未修改业务说明，定向验证与发布成功");

  // 阶段三：在新条件下再执行一次正式回归，确认补丁可重复执行。
  phase = "final-regression";
  const final = await workflow.run(workspace, { caseId, revision: "0002", mode: "regression" });
  assert.equal(final.status, "passed", JSON.stringify((await read(final.summaryFile)).problems));
  evidence.finalRegression = { runId: final.runId, status: final.status, durationMs: final.durationMs };
  evidence.checks.push("补丁版本在新条件下正式回归通过");
  evidence.status = "passed";
} catch (error) {
  if (error?.setupOnly) evidence.status = "setup-passed";
  else {
    evidence.status = "failed";
    evidence.error = { message: error.message, stack: error.stack?.split("\n").slice(0, 6) };
    process.exitCode = 1;
  }
} finally {
  evidence.finishedAt = new Date().toISOString();
  evidence.requests = requests;
  evidence.eventSummary = {
    toolStarts: events.filter((item) => item.type === "tool_start").map((item) => ({ phase: item.phase, toolName: item.toolName })),
    assistantMessages: events.filter((item) => item.type === "assistant").length,
    usage: events.filter((item) => item.type === "assistant" && item.usage).map((item) => item.usage),
    retries: events.filter((item) => item.type === "auto_retry_start"),
  };
  await write(path.join(base, "check-summary.json"), evidence);
  await fs.writeFile(path.join(base, "events.json"), JSON.stringify(events, null, 2));
  if (session) {
    try { await lifecycle.closePiSession(session); } catch (error) { evidence.closeError = error.message; }
  }
  server.closeAllConnections?.();
  await new Promise((resolve) => server.close(resolve));
  process.stdout.write(JSON.stringify({ status: evidence.status, candidate: evidence.candidate?.taskId,
    repair: evidence.repair?.taskId, error: evidence.error?.message }) + "\n");
}
