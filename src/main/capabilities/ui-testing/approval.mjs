import fs from "node:fs/promises";
import path from "node:path";
import { fork } from "node:child_process";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { resolveProject, readCredentials, matchesAddress } from "./project-context.mjs";
import { openLogin } from "./login-session.mjs";

const text = value => typeof value === "string" && value.trim().length > 0;
function check(value, message) { if (!value) throw new Error(message); }
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function keys(value, names) {
  check(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).every(key => names.includes(key)), "审批参数包含未支持字段；不得传入凭据正文。");
}
function authorization(value) {
  keys(value, ["kind", "reference"]);
  check(["user", "rule", "baseline"].includes(value.kind) && text(value.reference), "需要可追溯的授权来源。");
}

function checks(items) {
  check(Array.isArray(items) && items.length > 0 && items.length <= 30, "节点必须声明有来源的前后状态检查。");
  for (const item of items) {
    keys(item, ["selector", "text", "kind"]);
    check(text(item.selector) && text(item.text) && [undefined, "text", "value"].includes(item.kind), "状态检查需要 selector/text。");
  }
}

function validateConfiguration(config, id) {
  keys(config, ["source", "record", "actors", "residualAuthorization"]);
  authorization(config.residualAuthorization);
  checks([config.record]);
  check(text(config.source) && Array.isArray(config.actors) && config.actors.length > 0, "必须提供流程来源与人员映射。");
  const actorIds = new Set();
  for (const actor of config.actors) {
    keys(actor, ["id", "account", "source", "credentialSource", "identity", "login"]);
    if (actor.login) {
      keys(actor.login, ["account", "password", "submit", "tenant"]);
      for (const key of ["account", "password", "submit"]) check(actor.login[key] === undefined || text(actor.login[key]), "登录配置只能声明选择器。");
      if (actor.login.tenant) {
        keys(actor.login.tenant, ["selector", "confirm"]);
        check(text(actor.login.tenant.selector) && (actor.login.tenant.confirm === undefined || text(actor.login.tenant.confirm)), "租户选择需要目标，独立确认控件可选。");
      }
    }
    id(actor.id);
    check(!actorIds.has(actor.id) && text(actor.account) && text(actor.source) && ["project", "test-password"].includes(actor.credentialSource), "人员映射或认证来源无效。");
    checks([actor.identity]); actorIds.add(actor.id);
  }
}

async function authenticationPreflight(runtime, project, actors = []) {
  const configured = await readCredentials(runtime, project);
  const projectCredentialsConfigured = text(configured.account) && text(configured.password);
  const sharedTestPasswordConfigured = text(process.env.QA_UI_TEST_PASSWORD);
  const results = actors.map(actor => {
    const missing = [];
    if (!text(actor.account)) missing.push("account");
    if (!text(actor.source)) missing.push("source");
    if (!text(actor.identity?.selector) || !text(actor.identity?.text)) missing.push("identity");
    if (actor.credentialSource === "project") {
      if (!projectCredentialsConfigured) missing.push("project-credentials");
      if (actor.account !== configured.account) missing.push("project-account-mismatch");
    } else if (actor.credentialSource === "test-password") {
      if (!sharedTestPasswordConfigured) missing.push("test-password");
    } else missing.push("credentialSource");
    return { actorId: actor.id, configured: missing.length === 0, missing };
  });
  return { status: results.length > 0 && results.every(actor => actor.configured) ? "configured" : "incomplete",
    verification: "configuration-only", projectCredentialsConfigured, sharedTestPasswordConfigured,
    missing: results.length ? [] : ["actors"], actors: results };
}

export function validateApprovalStep(step, plan) {
  keys(step, ["id", "name", "source", "actorId", "url", "before", "after", "actions", "capture", "createsRecord", "terminal"]);
  check(step && /^[a-zA-Z0-9_-]{1,80}$/.test(step.id) && text(step.name) && text(step.source), "审批节点需要稳定编号、名称和规则来源。");
  check(plan.actors.some(actor => actor.id === step.actorId), "节点处理人未登记。");
  check(matchesAddress(plan.address, step.url) && !new URL(step.url).username && !new URL(step.url).password, "节点地址超出项目范围。");
  checks(step.before); checks(step.after);
  check(Array.isArray(step.actions) && step.actions.length > 0 && step.actions.length <= 40, "每个节点需要 1–40 个明确动作。");
  for (const action of step.actions) {
    keys(action, ["kind", "selector", "value", "file"]);
    check(["click", "fill", "select", "upload"].includes(action.kind) && text(action.selector), "审批仅支持 click/fill/select/upload。");
    if (["fill", "select"].includes(action.kind)) check(text(action.value), "填写与选择必须提供明确业务值。");
    if (action.kind === "upload") check(text(action.file) && !path.isAbsolute(action.file), "附件须使用工作区相对文件路径。");
  }
  if (step.capture) {
    keys(step.capture, ["name", "query", "selector", "attribute"]);
    check(/^[a-zA-Z][a-zA-Z0-9]*$/.test(step.capture.name) && step.capture.name !== "runId" &&
    (text(step.capture.query) !== Boolean(text(step.capture.selector) && text(step.capture.attribute))), "记录标识提取需声明唯一 query 或 selector/attribute。");
  }
}

export async function approvalStates(runtime, project, actors, signal) {
  const configured = await readCredentials(runtime, project);
  const states = {};
  for (const actor of actors) {
    signal?.throwIfAborted();
    const credentials = actor.credentialSource === "project"
      ? (check(actor.account === configured.account, "project 凭据只能用于项目已配置账号。"), configured)
      : { account: actor.account, password: process.env.QA_UI_TEST_PASSWORD };
    if (!text(credentials.password)) throw Object.assign(new Error("宿主缺少对应测试认证：project 或 QA_UI_TEST_PASSWORD；不会猜密码或读取 .env。"), { code: "credentials-missing", stage: "configuration", actorId: actor.id });
    const entry = await openLogin(runtime, project.targetUrl, signal);
    try {
      const result = await entry.auto(credentials, { ...actor.login, authenticated: actor.identity.selector, identityText: actor.identity.text }, signal);
      if (!["saved", "not-required"].includes(result.status)) throw Object.assign(new Error(`节点账号认证或身份核验未通过（${result.code ?? "login-unconfirmed"}）；未执行审批。`),
        { code: result.code ?? "login-unconfirmed", stage: result.stage ?? "authentication", actorId: actor.id, diagnostics: result.diagnostics });
      states[actor.id] = result.status === "saved" ? JSON.parse(await fs.readFile(entry.file, "utf8")) : { cookies: [], origins: [] };
    } finally {
      try { await entry.cleanup(); } catch (error) { error.cleanupUnconfirmed = true; throw error; }
    }
  }
  return states;
}

async function browserStep(runtime, message, signal) {
  signal?.throwIfAborted();
  return new Promise(resolve => {
    const child = fork(path.join(runtime.directory, "approval-browser.cjs"), [], {
      execPath: runtime.node, execArgv: [], stdio: ["ignore", "ignore", "ignore", "ipc"], detached: process.platform !== "win32",
      env: { ...process.env, QA_UI_TEST_PASSWORD: "", NODE_PATH: runtime.modules, PLAYWRIGHT_BROWSERS_PATH: runtime.browsers },
    });
    let result, forceTimer, stopping = false;
    const stop = () => {
      if (stopping) return;
      stopping = true;
      child.kill("SIGTERM");
      forceTimer = setTimeout(() => {
        if (process.platform !== "win32" && child.pid) {
          try { process.kill(-child.pid, "SIGKILL"); } catch { /* 已退出时由 close 收尾。 */ }
        } else child.kill("SIGKILL");
      }, 10000);
    };
    signal?.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, 120000);
    child.on("message", value => { result = value; });
    child.once("error", () => { result = { status: "blocked", cleanupConfirmed: !child.pid, reason: "审批浏览器进程未能启动。" }; });
    child.once("close", () => {
      clearTimeout(timer); clearTimeout(forceTimer); signal?.removeEventListener("abort", stop);
      resolve(result ?? { status: "unknown", cleanupConfirmed: false, reason: "审批进程中断，结果及收尾未确认；禁止重放。" });
    });
    child.send(message, () => {});
    if (signal?.aborted) stop();
  });
}

export async function approvalOperation(root, params, signal, helpers) {
  const { runtime, id, directory, fileAt, writeJson, validateContract } = helpers;
  const promptFile = path.join(runtime.directory, "prompt/approval-control.md");
  const instructions = (await fs.readFile(promptFile, "utf8")).trim();
  check(instructions, "审批提示词为空，停止审批分支。");
  if (params.operation === "instructions") return { promptFile, instructions };
  check(params.reconcileAfter === undefined || params.operation === "reconcile", "结果定位纠错只允许只读 reconcile，不得用于 execute。");
  check(["preflight", "prepare", "configure-login", "inspect", "execute", "reconcile", "candidate"].includes(params.operation), "未知审批操作。");
  if (params.operation === "preflight" && !params.flowId) {
    const project = await resolveProject(runtime, params, root.workspace, async () => root);
    check(await fs.realpath(project.projectWorkspace) === root.workspace, "审批项目不属于当前工作区。");
    return { configurationSource: params.config?.actors ? "config" : "none",
      ...(params.config?.actors ? {} : { reason: "本次未提供人员配置；未检查任何已保存审批计划。" }),
      ...await authenticationPreflight(runtime, project, params.config?.actors) };
  }
  id(params.flowId);
  const dir = await directory(root.base, "approvals", params.flowId);
  const file = path.join(dir, "flow.json");
  let flow, created = false;
  try { flow = JSON.parse(await fs.readFile(await fileAt(dir, "flow.json"), "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!flow) {
    check(["inspect", "prepare"].includes(params.operation) && params.config, "新审批流先 prepare 或 inspect 并提供 config。");
    check(params.baseRevision === undefined || params.baseRevision === 0, "新审批流配置版本须为 0。");
    const config = structuredClone(params.config);
    validateConfiguration(config, id);
    const project = await resolveProject(runtime, params, root.workspace, async () => root);
    check(await fs.realpath(project.projectWorkspace) === root.workspace, "审批项目不属于当前工作区。");
    flow = { schema: "qa-ui-approval/v1", flowId: params.flowId, workspace: root.workspace, project: { id: project.projectId, name: project.projectName, address: project.address },
      targetUrl: project.targetUrl, config, configRevision: 1, configHistory: [], phase: "preparing",
      variables: { runId: params.flowId }, steps: [], createdAt: new Date().toISOString() };
    await writeJson(file, flow);
    created = true;
  } else if (params.config && params.operation !== "prepare") check(same(params.config, flow.config), "配置变更须显式 prepare 并引用当前配置版本；冻结后禁止修改。");
  check(flow.schema === "qa-ui-approval/v1" && flow.flowId === params.flowId && flow.workspace === root.workspace, "审批记录归属不一致。");
  const project = await resolveProject(runtime, { projectId: flow.project.id, targetUrl: flow.targetUrl }, root.workspace, async () => root);
  check(await fs.realpath(project.projectWorkspace) === root.workspace && project.address === flow.project.address, "审批项目配置或归属已变化。");
  // 旧零步骤计划仅能通过显式 prepare 修订；存在任何执行意图即保持冻结。
  flow.configRevision ??= 1;
  flow.phase = flow.steps.length || flow.frozenAt || flow.candidateTaskId || flow.phase === "frozen" ? "frozen" : "preparing";
  if (params.operation === "preflight") return { configurationSource: "flow", flowId: flow.flowId, phase: flow.phase, configRevision: flow.configRevision,
    ...await authenticationPreflight(runtime, project, flow.config.actors) };
  if (params.operation === "configure-login") {
    // 仅修正认证页面定位；已执行的业务规则、人员身份和动作证据保持冻结。
    check(!flow.candidateTaskId && flow.steps.every(item => item.status === "completed"), "已有结果未确认或已生成候选，禁止修改登录选择器。");
    check(params.baseRevision === flow.configRevision, "配置版本已变化或未提供 baseRevision，停止修订。");
    check(params.config === undefined && params.step === undefined && params.targetUrl === undefined, "登录修订只接受 actorId/login，不能变更业务配置或入口。");
    authorization(params.authorization);
    const config = structuredClone(flow.config);
    const actor = config.actors.find(item => item.id === params.actorId);
    check(actor && params.login, "登录修订需要已登记人员与明确选择器。");
    actor.login = structuredClone(params.login);
    validateConfiguration(config, id);
    if (!same(config, flow.config)) {
      flow.configHistory ??= [];
      flow.configHistory.push({ revision: flow.configRevision, config: structuredClone(flow.config), change: "login-selectors", actorId: actor.id, authorization: params.authorization });
      flow.config = config; flow.configRevision++;
      await writeJson(file, flow);
    }
    return { flowId: flow.flowId, phase: flow.phase, configRevision: flow.configRevision, actorId: actor.id, verification: "configuration-only" };
  }
  if (params.operation === "prepare") {
    check(flow.phase === "preparing", "已有执行记录或冻结标记，禁止修改配置。");
    check(params.targetUrl === undefined || params.targetUrl === flow.targetUrl,
      "prepare 不修改已保存计划的入口；新建测试须使用新的 flowId 和新建入口，保留旧计划。");
    check(created || params.baseRevision === flow.configRevision, "配置版本已变化或未提供 baseRevision，停止修订。");
    validateConfiguration(params.config, id);
    if (!same(params.config, flow.config)) {
      flow.configHistory ??= [];
      flow.configHistory.push({ revision: flow.configRevision, config: structuredClone(flow.config) });
      flow.config = structuredClone(params.config); flow.configRevision++;
    }
    await writeJson(file, flow);
    return { flowId: flow.flowId, phase: flow.phase, configRevision: flow.configRevision };
  }
  const plan = { address: flow.project.address, ...flow.config, files: flow.files ?? {}, steps: flow.steps.map(item => item.reconciledStep ?? item.step) };
  let previous = flow.steps.at(-1), retry;
  if (params.operation === "execute" && params.retryEvidence) {
    retry = previous;
    check(retry && retry.step.id === params.step?.id && retry.evidence === params.retryEvidence && retry.status === "unknown" && !retry.attempts,
      "仅可明确引用最近一次未确认的控件定位失败，且最多纠正一次。");
    const result = JSON.parse(await fs.readFile(await fileAt(dir, retry.evidence, "check.json"), "utf8"));
    const index = result.actionIndex;
    const actions = (await fs.readFile(await fileAt(dir, retry.evidence, "actions.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    const intents = (await fs.readFile(await fileAt(dir, retry.evidence, "intents.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    check(result.cleanupConfirmed === true && result.stage === "target" && Number.isInteger(index) && index > 0 &&
      actions.length === index && intents.length === index && retry.step.actions.slice(0, index).every(action => action.kind === "fill") &&
      intents.every((intent, i) => intent.index === i && intent.kind === "fill"),
    "审批点击或其他写动作可能已开始，只能 reconcile，禁止重放。");
    const comparable = structuredClone(params.step);
    check(comparable.actions?.length === retry.step.actions.length && comparable.actions[index], "定位纠错不能改变动作数量。");
    check(comparable.actions[index].selector !== retry.step.actions[index].selector, "定位纠错须提供有新证据的不同选择器。");
    comparable.actions[index].selector = retry.step.actions[index].selector;
    check(isDeepStrictEqual(comparable, retry.step), "定位纠错只能修改未开始动作的 selector，业务预期、人员及输入必须不变。");
    previous = flow.steps.at(-2);
  }
  if (params.operation === "candidate") {
    check(previous?.status === "completed" && previous.step.terminal === true && flow.steps.every(item => item.status === "completed"), "审批链尚未确认终态，不能生成完整链候选。");
    check(flow.steps[0].step.createsRecord === true && JSON.stringify(flow.steps[0].step).includes("{{runId}}"), "独立回放须从创建本轮唯一记录开始，不能复用固定存量记录。");
    id(params.caseId);
    const contract = structuredClone(params.contract);
    validateContract(contract);
    check(contract.mode === "complete" && contract.dataStrategy === "isolated-write" && contract.cleanup === "residual", "审批完整链使用 complete/isolated-write，需显式接受 residual 并提供授权。");
    check(same(contract.residualAuthorization, flow.config.residualAuthorization), "回放残留授权必须沿用已确认的流程授权。");
    check(flow.steps[0].step.actorId === flow.config.actors[0].id, "首个登记人员须为创建人。");
    for (const expected of contract.expected) check(flow.steps.some(item => item.step.source === expected.source.reference && item.step.after.some(after => after.text === expected.text)), "每条业务预期必须映射到同来源节点的真实 after 断言。");
    check(contract.role === "approval-workflow" && same(contract.identity, flow.config.actors[0].identity), "完整链身份须绑定首个登记人员，role 使用 approval-workflow。");
    check(text(params.title) && Array.isArray(params.modulePath) && params.modulePath.length > 0 && params.modulePath.every(text), "需要用例标题与业务目录。");
    if (flow.candidateTaskId) {
      check(flow.caseId === params.caseId, "审批链已绑定其他 caseId，不能重复生成。");
      return { taskId: flow.candidateTaskId, draftDirectory: path.join(root.base, "tasks", flow.candidateTaskId, "drafts", params.caseId), status: "draft-prepared" };
    }
    const taskId = `task-${randomUUID()}`;
    const taskDir = await directory(root.base, "tasks", taskId);
    const draft = await directory(taskDir, "drafts", params.caseId);
    const records = [];
    for (const item of flow.steps) {
      const lines = (await fs.readFile(await fileAt(dir, item.evidence, "actions.jsonl"), "utf8")).trim().split("\n").map(JSON.parse);
      check(lines.length === item.step.actions.length, "节点动作证据不完整，不能把状态核对推算成成功轨迹。");
      records.push(...lines);
    }
    const task = { schema: "qa-ui-task/v1", workflow: "browser-use-playwright", taskId, workspace: root.workspace,
      project: flow.project, targetUrl: flow.targetUrl, contract, approvalPlan: plan, status: "completed",
      startedAt: flow.createdAt, finishedAt: new Date().toISOString(), terminal: { status: "completed", cleanupConfirmed: true } };
    await writeJson(path.join(taskDir, "task.json"), task);
    await fs.writeFile(path.join(taskDir, "actions.jsonl"), records.map(item => JSON.stringify(item)).join("\n") + "\n", { flag: "wx", mode: 0o600 });
    const meta = { schema: "qa-ui-case/v1", caseId: params.caseId, taskId, project: { id: flow.project.id, name: flow.project.name },
      targetUrl: flow.targetUrl, title: params.title, modulePath: params.modulePath, role: contract.role, initialState: contract.initialState,
      dataStrategy: contract.dataStrategy, cleanup: contract.cleanup, writeAuthorization: contract.writeAuthorization,
      residualAuthorization: contract.residualAuthorization, expected: contract.expected, approvalPlan: plan,
      steps: records.map(item => ({ stepId: item.stepId, text: `审批动作 ${item.stepId}` })),
      assertions: contract.expected.map(item => ({ kind: "business", expectedId: item.id, text: item.text })) };
    await writeJson(path.join(draft, "case.json"), meta);
    const script = `const { test, expect } = require("@playwright/test");\nconst { runPlan } = require(process.env.QA_UI_APPROVAL_RUNNER);\nconst { approvalPlan } = require("./case.json");\ntest(${JSON.stringify(params.title)}, async ({ browser }, testInfo) => {\n  const runId = process.env.QA_RUN_ID;\n  // QA_RUN_ID 驱动独立数据，helper 保存 qa-initial-state、qa-business-result、qa-residue。\n  const result = await runPlan(browser, approvalPlan, testInfo, runId);\n  expect(result.status).toBe("completed");\n});\n`;
    await fs.writeFile(path.join(draft, "case.spec.cjs"), script, { flag: "wx", mode: 0o600 });
    flow.candidateTaskId = taskId; flow.caseId = params.caseId; await writeJson(file, flow);
    return { taskId, draftDirectory: draft, status: "draft-prepared", next: "qa_ui_save_candidate，再 validate；不得直接称已发布。" };
  }
  check(["inspect", "execute", "reconcile"].includes(params.operation), "未知审批操作。");
  const step = params.operation === "reconcile" && previous ? { ...previous.step, url: params.targetUrl ?? previous.step.url } : params.step;
  check(step && plan.actors.some(actor => actor.id === step.actorId), "需要明确节点及登记人员。");
  if (params.reconcileAfter) {
    const correction = params.reconcileAfter;
    keys(correction, ["source", "checks"]);
    checks(correction.checks);
    check(previous?.status === "unknown" && !previous.reconcileCorrection && text(correction.source), "结果定位纠错须有新证据且仅允许一次。");
    const result = JSON.parse(await fs.readFile(await fileAt(dir, previous.evidence, "check.json"), "utf8"));
    const actions = (await fs.readFile(await fileAt(dir, previous.evidence, "actions.jsonl"), "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse);
    check(result.stage === "after" && result.cleanupConfirmed === true && actions.length === step.actions.length,
      "仅完整动作后的结果定位失败可纠错；不得补造动作或重放。");
    check(isDeepStrictEqual(correction.checks.map(({ selector, ...expected }) => expected), step.after.map(({ selector, ...expected }) => expected)) &&
      correction.checks.some((item, index) => item.selector !== step.after[index].selector), "只允许修改结果 selector，预期、顺序和检查数量必须不变。");
    step.after = structuredClone(correction.checks);
    previous.reconcileCorrection = structuredClone(correction);
    await writeJson(file, flow);
  }
  if (params.operation === "inspect") {
    checks(step.before);
    check(!step.createsRecord || flow.steps.length === 0, "已有执行记录的 inspect 不能跳过记录核对。");
  }
  if (params.operation === "execute") {
    validateApprovalStep(step, plan);
    check(retry || !flow.steps.some(item => item.step.id === step.id), "该节点已有执行记录，禁止重复执行；先 inspect/reconcile。");
    check(!previous || (previous.status === "completed" && previous.step.terminal !== true), "上一节点未确认或已终态，不能继续提交。");
    check((params.previousStepId ?? null) === (previous?.step.id ?? null), "必须引用最近已确认节点，禁止跳过状态衔接。");
    authorization(params.authorization);
    if (flow.steps.length > 0) check(!step.createsRecord, "同一审批流不得再次创建记录。");
    const preflight = await authenticationPreflight(runtime, project, flow.config.actors);
    if (preflight.status !== "configured") return { flowId: flow.flowId, phase: flow.phase, configRevision: flow.configRevision,
      ...preflight, status: "blocked", code: "authentication-configuration-incomplete", stage: "configuration", reason: "人员认证配置不齐备，未冻结或执行业务动作。" };
  }
  if (params.operation === "reconcile") check(previous && previous.status !== "completed", "没有结果待确认的节点。");
  const evidence = `check-${randomUUID()}`;
  const output = await directory(dir, evidence);
  const actor = plan.actors.find(item => item.id === step.actorId);
  // 使用节点真实地址登录，避免把发起页身份标识用于其他处理页面。
  const variables = structuredClone(flow.variables);
  const url = step.url.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, key) => {
    check(variables[key] !== undefined, `缺少流程变量：${key}`); return String(variables[key]);
  });
  check(matchesAddress(project.address, url), "节点 URL 超出项目范围。");
  const inspection = { operation: params.operation, actorId: actor.id, configRevision: flow.configRevision, url };
  await writeJson(path.join(output, "check.json"), inspection);
  let states;
  try { states = await approvalStates(runtime, { ...project, targetUrl: url }, [actor], signal); }
  catch (error) {
    if (error.cleanupUnconfirmed) { root.keepLock = true; throw error; }
    const result = { flowId: flow.flowId, status: "blocked", code: error.code ?? "login-unconfirmed", stage: error.stage ?? "authentication",
      actorId: actor.id, diagnostics: error.diagnostics, reason: "节点认证未通过，未开始业务动作。", phase: flow.phase, configRevision: flow.configRevision, evidenceDirectory: output };
    await writeJson(path.join(output, "check.json"), { ...inspection, ...result });
    return result;
  }
  const executable = structuredClone(step);
  for (const action of executable.actions ?? []) {
    if (action.kind === "upload") {
      const parts = action.file.split(/[\\/]/);
      check(parts.every(part => part && part !== "." && part !== ".."), "附件路径不能逃出工作区。");
      action.file = await fileAt(root.workspace, ...parts);
      const digest = createHash("sha256").update(await fs.readFile(action.file)).digest("hex");
      flow.files ??= {};
      const relative = parts.join("/");
      check(!flow.files[relative] || flow.files[relative] === digest, "审批附件已变化，停止操作。");
      flow.files[relative] = digest;
    }
  }
  let entry;
  if (params.operation === "execute") {
    flow.phase = "frozen"; flow.frozenAt ??= new Date().toISOString();
    entry = { step: structuredClone(step), configRevision: flow.configRevision, status: "unknown", evidence, authorization: params.authorization };
    if (retry) { entry.attempts = [retry]; flow.steps[flow.steps.length - 1] = entry; }
    else flow.steps.push(entry);
    await writeJson(file, flow);
  }
  let result;
  try { result = await browserStep(runtime, { plan, step: executable, states, variables, operation: params.operation, output }, signal); }
  catch (error) { root.keepLock = true; throw error; }
  if (result.cleanupConfirmed === false) {
    root.keepLock = true; result.status = "unknown"; result.reason = "浏览器收尾未确认，保留工作区锁并停止依赖链。";
  }
  await writeJson(path.join(output, "check.json"), { ...inspection, ...result });
  if (params.operation === "execute") {
    entry.status = result.status; entry.reason = result.reason;
    if (result.status === "completed") flow.variables = result.variables;
    await writeJson(file, flow);
  } else if (params.operation === "reconcile" && result.status === "completed") {
    if (params.reconcileAfter) previous.reconciledStep = { ...previous.step, after: step.after };
    delete previous.reason;
    previous.status = "completed"; previous.reconciledEvidence = evidence; flow.variables = result.variables; await writeJson(file, flow);
  }
  return { flowId: flow.flowId, status: result.status, reason: result.reason, code: result.code, stage: result.stage, actionIndex: result.actionIndex, diagnostics: result.diagnostics,
    phase: flow.phase, configRevision: flow.configRevision, stepId: step.id, variables: flow.variables,
    evidenceDirectory: output, controls: result.controls, pageText: result.pageText, url: result.url, instructions: params.operation === "inspect" ? instructions : undefined,
    terminal: result.status === "completed" && step.terminal === true };
}
