import path from "node:path";
import fs from "node:fs/promises";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolveProject, readCredentials } from "./project-context.mjs";
import { openLogin } from "./login-session.mjs";

const require = createRequire(import.meta.url);
const workflow = "browser-use-playwright";
const executeFile = promisify(execFile);
const hash = (data) => createHash("sha256").update(data).digest("hex");
const json = async (file) => JSON.parse(await fs.readFile(file, "utf8"));
const text = (value) => typeof value === "string" && value.trim().length > 0;
function check(condition, message) { if (!condition) throw new Error(message); }
function id(value) {
  check(typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value), "对象编号无效。");
  return value;
}
async function writeJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(value, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await fs.rename(temporary, file);
}
// 不跟随 qa/ui 下的链接；所有工具均从实际会话目录解析对象编号。
async function directory(workspace, ...parts) {
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const stat = await fs.lstat(current);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "UI 数据目录不能使用符号链接或同名文件。");
  }
  return current;
}
async function fileAt(base, ...parts) {
  check(!(await fs.lstat(base)).isSymbolicLink(), "UI 资产目录不能使用符号链接。");
  const file = path.join(base, ...parts);
  let current = base;
  for (const part of parts) {
    current = path.join(current, part);
    check(!(await fs.lstat(current)).isSymbolicLink(), "UI 资产不能使用符号链接。");
  }
  check((await fs.stat(file)).isFile(), "UI 资产不是文件。");
  return file;
}
async function roots(cwd) {
  check(path.isAbsolute(cwd), "需要当前会话的绝对工作目录。");
  const workspace = await fs.realpath(cwd);
  const base = await directory(workspace, "qa", "ui");
  for (const part of ["tasks", "cases", "runs"]) await directory(base, part);
  return { workspace, base, workspaceRoot: workspace, caseDir: path.join(base, "cases") };
}
async function exclusive(cwd, operation) {
  const root = await roots(cwd);
  let lock;
  try { lock = await fs.open(path.join(root.base, ".workflow.lock"), "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("该工作区已有 UI 任务或上次任务未收尾；停止新任务，先核对原任务状态。");
    throw error;
  }
  try { return await operation(root); }
  finally {
    await lock.close();
    // 收尾未知时保留互斥标记，禁止新任务覆盖需要人工核对的现场。
    if (!root.keepLock) await fs.unlink(path.join(root.base, ".workflow.lock"));
  }
}

// 面板整例删除与探索、保存、回放、发布共用同一把工作区锁。
export async function removeUiCase(cwd, { projectId, caseId, assetHash }) {
  id(caseId);
  check(text(projectId) && typeof assetHash === "string" && /^[a-f0-9]{64}$/.test(assetHash), "删除用例参数无效。");
  return exclusive(cwd, async (root) => {
    const file = await fileAt(root.caseDir, caseId, "asset.json");
    const bytes = await fs.readFile(file);
    check(hash(bytes) === assetHash, "用例版本已变化，请刷新后重新确认删除。");
    const asset = JSON.parse(bytes);
    check(asset.schema === "qa-ui-asset/v1" && asset.caseId === caseId && asset.revisions?.length > 0, "用例版本索引无效。");
    for (const entry of asset.revisions) {
      check(typeof entry.revision === "string" && /^\d{4}$/.test(entry.revision), "用例版本无效。");
      const metaBytes = await fs.readFile(await fileAt(root.caseDir, caseId, "revisions", entry.revision, "case.json"));
      check(hash(metaBytes) === entry.hashes?.["case.json"], "用例说明已变更，请保留现场并核对版本。");
      const meta = JSON.parse(metaBytes);
      check(meta.schema === "qa-ui-case/v1" && meta.caseId === caseId && (meta.taskId === entry.taskId || meta.taskId === entry.baseTaskId) && meta.project?.id === projectId, "用例不属于所选项目或来源不匹配。");
    }
    await fs.rm(path.join(root.caseDir, caseId), { recursive: true });
    return { caseId };
  });
}

// 只删除无版本引用的运行材料；损坏索引不能被当成“没有引用”。
export async function removeUiReport(cwd, { projectId, runId }) {
  id(runId);
  check(text(projectId), "删除报告参数无效。");
  return exclusive(cwd, async (root) => {
    const runFile = await fileAt(root.base, "runs", runId, "summary.json");
    const summary = await json(runFile);
    check(summary.schema === "qa-report/v1" && summary.kind === "ui" && summary.workflow === workflow &&
      summary.runId === runId && summary.project?.id === projectId && summary.workspace === root.workspace,
    "UI 报告格式或项目/工作区归属无效，不能删除。");
    const task = await json(await fileAt(root.base, "runs", runId, "task.json"));
    check(task.runId === runId && task.workflow === workflow && task.project?.id === projectId && task.workspace === root.workspace,
      "测试批次任务归属无效，不能删除。");
    check(!["prepared", "running"].includes(task.status), "测试批次正在执行或未收尾，不能删除。");
    for (const entry of await fs.readdir(path.join(root.base, "tasks"), { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      check(entry.isDirectory() && !entry.isSymbolicLink(), "存在无效任务目录，无法确认报告引用。");
      let related;
      // 非修复任务或历史目录不参与引用判断；无法解析的任务不是有效修复来源。
      try { related = await json(await fileAt(root.base, "tasks", entry.name, "task.json")); }
      catch { continue; }
      check(!(related?.kind === "repair" && related.repair?.parentRunId === runId), "报告仍被修复任务引用，不能删除。");
    }
    for (const entry of await fs.readdir(root.caseDir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      check(entry.isDirectory() && !entry.isSymbolicLink(), "存在无效用例目录，无法确认报告引用。");
      const asset = await json(await fileAt(root.caseDir, entry.name, "asset.json"));
      check(asset.schema === "qa-ui-asset/v1" && asset.caseId === entry.name && Array.isArray(asset.revisions) && asset.revisions.length > 0,
        "存在无效版本索引，无法确认报告引用。");
      for (const revision of asset.revisions) {
        check(typeof revision.revision === "string" && /^\d{4}$/.test(revision.revision), "版本索引无效，无法确认报告引用。");
        check(revision.validationRunId !== runId && revision.validatedRunId !== runId,
          "报告仍被用例版本的验证记录引用；请先删除对应用例，再清理报告。");
      }
    }
    await fs.rm(path.dirname(runFile), { recursive: true });
    return { kind: "ui", id: runId };
  });
}

// 只读与隔离写共用同一套数据策略校验；写操作必须声明授权来源。
function checkDataStrategy(contract) {
  const isolated = contract.dataStrategy === "isolated-write";
  check(contract.dataStrategy === "read-only" || isolated, "dataStrategy 必须是 read-only 或 isolated-write。");
  if (isolated) {
    check(["in-test", "residual"].includes(contract.cleanup),
      "隔离写任务 cleanup 必须为 in-test（用例内清理）或 residual（明确接受残留）。");
    check(contract.writeAuthorization && ["user", "rule", "baseline"].includes(contract.writeAuthorization.kind) &&
      text(contract.writeAuthorization.reference), "隔离写任务必须声明业务写操作授权及来源。");
    if (contract.cleanup === "residual") {
      check(contract.residualAuthorization && ["user", "rule", "baseline"].includes(contract.residualAuthorization.kind) &&
        text(contract.residualAuthorization.reference), "声明残留的写任务必须提供 residualAuthorization 明确接受残留数据。");
    }
  } else {
    check(contract.cleanup === "none", "只读任务 cleanup 必须为 none。");
    check(contract.writeAuthorization === undefined && contract.residualAuthorization === undefined, "只读任务不能声明写操作或残留授权。");
  }
}

export function validateContract(contract) {
  check(contract && ["explore", "candidate", "complete"].includes(contract.mode), "任务 mode 必须为 explore、candidate 或 complete。");
  for (const field of ["goal", "role", "initialState"]) check(text(contract[field]), `任务缺少 ${field}。`);
  checkDataStrategy(contract);
  check(text(contract.identity?.selector) && text(contract.identity?.text), "必须声明可见身份标识和角色文本。");
  check(Array.isArray(contract.expected) && contract.expected.length > 0, "必须冻结业务预期及来源。");
  const ids = new Set();
  for (const item of contract.expected) {
    id(item.id);
    check(!ids.has(item.id) && text(item.text) && ["user", "rule", "baseline"].includes(item.source?.kind) && text(item.source.reference), "业务预期必须具有唯一编号、文本和明确来源。");
    ids.add(item.id);
  }
  check(Array.isArray(contract.completionTexts) && contract.completionTexts.length > 0 && contract.completionTexts.every(text), "必须声明完成时可见的业务信号。");
  check(Array.isArray(contract.controls) && contract.controls.length > 0, "必须限定允许的操作控件。");
  for (const control of contract.controls) {
    check(["click", "input", "select_dropdown"].includes(control.action), "只支持声明的点击、筛选输入和下拉动作。");
    check((text(control.name) && text(control.role)) || Object.keys(control.attributes ?? {}).length > 0, "控件需要稳定 role/name 或属性。");
    for (const attributes of [control.attributes, control.ancestor?.attributes]) {
      check(!attributes || Object.entries(attributes).every(([key, value]) => /^(id|role|aria-label|data-testid|data-row)$/.test(key) && text(value)), "控件属性必须来自稳定标识。");
    }
    if (control.action !== "click") check(Array.isArray(control.values) && control.values.length > 0 && control.values.every(text), "输入和下拉必须限定允许值。");
  }
  check(Number.isInteger(contract.budget?.maxSteps) && contract.budget.maxSteps >= 1 && contract.budget.maxSteps <= 12 &&
    Number.isInteger(contract.budget?.timeoutMs) && contract.budget.timeoutMs >= 1000 && contract.budget.timeoutMs <= 180000, "预算最多 12 步、180 秒。");
  check(text(contract.provider) && text(contract.modelId), "必须明确 Pi provider/model。");
}

async function modelConfig(contract, suppliedRuntime) {
  const { ModelRuntime } = await import("@mariozechner/pi-coding-agent");
  const runtime = suppliedRuntime ?? await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const selected = runtime.getModel(contract.provider, contract.modelId);
  check(selected?.api === "openai-completions", "探索只支持已验证的 OpenAI Chat Completions 兼容模型，不自动换模型。");
  check(!runtime.isUsingOAuth(selected.provider) && !runtime.isUsingSubscription(selected.provider), "探索尚不支持 OAuth 或订阅认证。");
  const resolved = await runtime.getAuth(selected);
  const endpoint = resolved?.auth.baseUrl || selected.baseUrl;
  check(resolved?.auth.apiKey && endpoint && new URL(endpoint).protocol === "https:", "模型需要已配置的 HTTPS 地址与 API Key。");
  return { model: selected.id, api_key: resolved.auth.apiKey, base_url: endpoint,
    default_headers: { ...selected.headers, ...resolved.auth.headers } };
}

async function login(runtime, project, contract, signal) {
  const entry = await openLogin(runtime, project.targetUrl, signal);
  try {
    const credentials = await readCredentials(runtime, project);
    const result = await entry.auto(credentials, { authenticated: contract.identity.selector }, signal);
    check(["saved", "not-required"].includes(result.status), "blocked：后台认证未通过；不会重交登录或人工接管。");
    const state = result.status === "saved" ? await json(entry.file) : { cookies: [], origins: [] };
    // browser-use 的 storage_state 尚未验证 IndexedDB 转换，不能静默丢失认证数据。
    check(!state.origins.some((origin) => origin.indexedDB?.length), "blocked：阶段 2 尚不支持 IndexedDB 登录态。");
    return state;
  } finally {
    try { await entry.cleanup(); }
    catch (error) { error.cleanupUnconfirmed = true; throw error; }
  }
}

function processRun(node, args, signal) {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(node, args, { detached: process.platform !== "win32", stdio: ["ignore", "ignore", "ignore"] });
    let timer;
    const abort = () => {
      child.kill("SIGINT");
      timer ??= setTimeout(() => {
        try {
          if (process.platform === "win32") child.kill("SIGKILL");
          else process.kill(-child.pid, "SIGKILL");
        } catch (error) { if (error.code !== "ESRCH") reject(new Error("执行进程组收尾未确认。")); }
      }, 8000);
    };
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", reject);
    child.once("close", (code, termination) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ code, termination });
    });
    if (signal?.aborted) abort();
  });
}

export function createReadOnlyWorkflow(runtime) {
  const { startProbe } = require(path.join(runtime.directory, "browser-use/bridge.cjs"));
  const { testsIn } = require(runtime.runner);
  async function boundTask(root, taskId) {
    const dir = await directory(root.base, "tasks", id(taskId));
    const task = await json(await fileAt(dir, "task.json"));
    check(task.workflow === workflow && task.workspace === root.workspace && task.taskId === taskId, "任务与当前工作区不匹配。");
    return { task, dir };
  }
  async function revision(root, caseId, number) {
    id(caseId);
    check(/^\d{4}$/.test(number), "revision 必须是四位数字。");
    const base = path.join(root.base, "cases");
    const asset = await json(await fileAt(base, caseId, "asset.json"));
    check(asset.schema === "qa-ui-asset/v1" && asset.caseId === caseId, "资产格式不匹配。");
    const entry = asset.revisions.find((item) => item.revision === number);
    check(entry, "未登记该 revision。");
    const files = {};
    for (const name of ["case.spec.cjs", "case.json"]) {
      const file = await fileAt(base, caseId, "revisions", number, name);
      check(hash(await fs.readFile(file)) === entry.hashes[name], "revision 文件已变更，不能执行或发布。");
      files[name] = file;
    }
    return { asset, entry, files, meta: await json(files["case.json"]) };
  }
  async function executeSelection(root, selections, mode, signal) {
    signal?.throwIfAborted();
    check(selections.length > 0, "没有可执行的正式用例。");
    const tasks = [];
    for (const selected of selections) {
      const { task } = await boundTask(root, selected.entry.taskId);
      check(task.status === "completed", "当前仅执行已完成任务的用例。");
      checkDataStrategy(task.contract);
      check(selected.meta.schema === "qa-ui-case/v1" && selected.meta.caseId === selected.asset.caseId &&
        (selected.meta.taskId === task.taskId || (task.kind === "repair" && selected.meta.taskId === task.repair.baseTaskId)) &&
        selected.meta.project?.id === task.project.id &&
        selected.meta.targetUrl === task.targetUrl && selected.meta.role === task.contract.role, "版本说明与来源任务不一致。");
      check(selected.meta.dataStrategy === task.contract.dataStrategy && selected.meta.cleanup === task.contract.cleanup,
        "版本数据策略与来源任务不一致。");
      if (task.contract.dataStrategy === "isolated-write") {
        check(JSON.stringify(selected.meta.writeAuthorization) === JSON.stringify(task.contract.writeAuthorization),
          "版本写授权与来源任务不一致。");
        check(JSON.stringify(selected.meta.residualAuthorization) === JSON.stringify(task.contract.residualAuthorization),
          "版本残留授权与来源任务不一致。");
      }
      if (task.kind === "repair") {
        check(selected.entry.baseRevision === task.repair.baseRevision && selected.entry.parentRunId === task.repair.parentRunId &&
          selected.entry.baseTaskId === task.repair.baseTaskId, "修复版本与修复任务不匹配。");
      }
      check(mode !== "validate" || task.contract.mode === "complete", "任务只允许生成候选，未授权独立回放。");
      check(mode !== "regression" || (selected.asset.currentRevision === selected.entry.revision && text(selected.entry.validatedRunId)), "普通回归只能执行当前正式版本，不能执行候选。");
      tasks.push(task);
    }
    const task = tasks[0];
    check(tasks.every((item) => ["id", "name", "address"].every((key) => item.project[key] === task.project[key]) &&
      item.targetUrl === task.targetUrl && item.contract.role === task.contract.role &&
      item.contract.identity.selector === task.contract.identity.selector && item.contract.identity.text === task.contract.identity.text), "批次必须使用同一项目、目标地址、角色和身份标识；请按范围拆分 case。");
    const project = await resolveProject(runtime, { targetUrl: task.targetUrl, projectId: task.project.id }, root.workspace, roots);
    check(await fs.realpath(project.projectWorkspace) === root.workspace, "项目归属与当前工作区不一致。");
    check(project.projectName === task.project.name && project.address === task.project.address, "项目配置已改变，请重新建立任务。");
    const caseId = selections[0].asset.caseId;
    const runId = `run-${randomUUID()}`;
    if (mode === "validate") {
      check(!selections[0].entry.validationRunId, "该候选已有定向验证批次；保留原结果，修改后保存新 revision。");
      selections[0].entry.validationRunId = runId;
      await writeJson(path.join(root.caseDir, caseId, "asset.json"), selections[0].asset);
    }
    const runDir = await directory(root.base, "runs", runId);
    const prepared = { workflow, mode: "run", purpose: mode, status: "prepared", runId, runDir,
      workspace: root.workspace, project: task.project, targetUrl: task.targetUrl,
      caseDir: root.caseDir, caseIds: selections.map((item) => item.asset.caseId), revisions: Object.fromEntries(selections.map((item) => [item.asset.caseId, item.entry.revision])),
      sourceTaskIds: Object.fromEntries(selections.map((item) => [item.asset.caseId, item.entry.taskId])),
      caseModules: Object.fromEntries(selections.map((item) => [item.asset.caseId, item.meta.modulePath])),
      caseFiles: selections.map((item) => item.files["case.spec.cjs"]), assetFiles: selections.map((item) => item.files["case.json"]),
      caseHashes: Object.fromEntries(selections.flatMap((item) => Object.entries(item.files).map(([name, file]) => [file, item.entry.hashes[name]]))),
      config: runtime.config, testCli: runtime.testCli, modules: runtime.modules, browsers: runtime.browsers,
      parentRunId: mode === "validate" && task.kind === "repair" ? task.repair.parentRunId : undefined,
      patchSummary: mode === "validate" ? selections[0].entry.patchSummary : undefined,
      dataStrategy: task.contract.dataStrategy,
      dataCleanup: task.contract.cleanup,
      writeAuthorization: task.contract.writeAuthorization ?? undefined,
      residualAuthorization: task.contract.residualAuthorization ?? undefined,
      resultsFile: path.join(runDir, "results.json"), htmlReport: path.join(runDir, "html/index.html"),
      summaryFile: path.join(runDir, "summary.json"), summaryDocument: path.join(runDir, "summary.md"), manifestFile: path.join(runDir, "manifest.json") };
    const taskFile = path.join(runDir, "task.json");
    await writeJson(taskFile, prepared);
    let privateDir;
    let executionStarted = false;
    let executionConfirmed = false;
    try {
      const state = await login(runtime, project, task.contract, signal);
      privateDir = await fs.mkdtemp(path.join(os.tmpdir(), "qa-ui-replay-"));
      await fs.chmod(privateDir, 0o700);
      const authFile = path.join(privateDir, "state.json");
      await fs.writeFile(authFile, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await writeJson(taskFile, { ...prepared, authFile, authDirectory: privateDir });
      executionStarted = true;
      const exit = await processRun(runtime.node, [runtime.runner, taskFile], signal);
      if (exit.termination) root.keepLock = true;
      const summary = await json(await fileAt(runDir, "summary.json"));
      check(exit.code === (summary.status === "passed" ? 0 : 1) && !exit.termination, "执行器退出与报告不一致，结果未确认。");
      executionConfirmed = summary.cleanup === "deleted";
      if (!executionConfirmed) root.keepLock = true;
      return { runId, status: summary.status, summaryFile: prepared.summaryFile, revisions: prepared.revisions,
        testCount: summary.testCount, counts: summary.counts, exitCode: summary.exitCode, cleanup: summary.cleanup, problems: summary.problems };
    } catch (error) {
      if (error.cleanupUnconfirmed || (executionStarted && !executionConfirmed)) root.keepLock = true;
      await writeJson(taskFile, { ...prepared, status: "incomplete", reason: error.message });
      throw error;
    } finally {
      if (privateDir) {
        try { await fs.rm(privateDir, { recursive: true, force: true }); }
        catch (error) { root.keepLock = true; throw error; }
      }
    }
  }
  // 已有用例的修复任务不启动探索浏览器；由首次保存根据原 revision 与失败父批次建立约定。
  async function createRepairTask(root, { caseId, baseRevision, parentRunId }) {
    check(text(baseRevision) && /^\d{4}$/.test(baseRevision), "建立修复任务必须提供原 revision。");
    id(parentRunId);
    const selected = await revision(root, caseId, baseRevision);
    check(selected.asset.currentRevision === baseRevision, "只能修复当前正式版本。");
    check(text(selected.entry.validatedRunId), "修复对象必须是已验证并发布的正式版本。");
    const baseTask = await boundTask(root, selected.entry.taskId);
    check(baseTask.task.status === "completed" && baseTask.task.contract.mode === "complete", "修复对象必须来自完整测试任务。");
    checkDataStrategy({ dataStrategy: selected.meta.dataStrategy, cleanup: selected.meta.cleanup,
      writeAuthorization: selected.meta.writeAuthorization, residualAuthorization: selected.meta.residualAuthorization });
    const summary = await json(await fileAt(root.base, "runs", parentRunId, "summary.json"));
    const runTask = await json(await fileAt(root.base, "runs", parentRunId, "task.json"));
    check(summary.schema === "qa-report/v1" && summary.kind === "ui" && summary.workflow === workflow &&
      summary.workspace === root.workspace && summary.project?.id === baseTask.task.project.id &&
      summary.purpose === "regression" && summary.status === "failed" && summary.runId === parentRunId &&
      Array.isArray(summary.caseIds) && summary.caseIds.includes(caseId) &&
      summary.revisions?.[caseId] === baseRevision, "父批次必须是该正式版本失败的新版回归批次。");
    check(runTask.runId === parentRunId && runTask.workflow === workflow && runTask.workspace === root.workspace && runTask.purpose === "regression",
      "父批次任务归属无效。");
    for (const item of await fs.readdir(path.join(root.base, "tasks"), { withFileTypes: true })) {
      if (!item.isDirectory() || item.name.startsWith(".")) continue;
      let existing;
      try { existing = await json(await fileAt(root.base, "tasks", item.name, "task.json")); }
      catch (error) { if (error.code !== "ENOENT") throw error; continue; }
      check(!(existing.kind === "repair" && existing.repair?.caseId === caseId && existing.repair?.parentRunId === parentRunId),
        "该失败批次已建立修复任务，请沿用原 taskId 继续补丁。");
    }
    const taskId = `task-${randomUUID()}`;
    const dir = await directory(root.base, "tasks", taskId);
    await directory(dir, "drafts");
    await directory(dir, "drafts", caseId);
    const task = {
      schema: "qa-ui-task/v1", workflow, kind: "repair", taskId, workspace: root.workspace,
      project: structuredClone(baseTask.task.project), targetUrl: baseTask.task.targetUrl,
      contract: { mode: "complete", goal: baseTask.task.contract.goal, role: selected.meta.role,
        identity: structuredClone(baseTask.task.contract.identity), expected: structuredClone(selected.meta.expected),
        initialState: selected.meta.initialState, dataStrategy: selected.meta.dataStrategy, cleanup: selected.meta.cleanup,
        writeAuthorization: selected.meta.writeAuthorization ? structuredClone(selected.meta.writeAuthorization) : undefined,
        residualAuthorization: selected.meta.residualAuthorization ? structuredClone(selected.meta.residualAuthorization) : undefined },
      repair: { caseId, baseRevision, baseTaskId: baseTask.task.taskId, parentRunId },
      status: "completed", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
    };
    await writeJson(path.join(dir, "task.json"), task);
    return { taskId, caseId, status: "repair-task", baseRevision, parentRunId, draftDirectory: path.join(dir, "drafts", caseId) };
  }

  return {
    async explore(cwd, params, signal, onEvent = () => {}) {
      validateContract(params.contract);
      return exclusive(cwd, async (root) => {
        signal?.throwIfAborted();
        const project = await resolveProject(runtime, params, cwd, roots);
        check(await fs.realpath(project.projectWorkspace) === root.workspace, "项目归属与当前工作区不一致。");
        const taskId = `task-${randomUUID()}`;
        const dir = await directory(root.base, "tasks", taskId);
        await directory(dir, "drafts");
        await directory(dir, "private");
        const task = { schema: "qa-ui-task/v1", workflow, taskId, workspace: root.workspace,
          project: { id: project.projectId, name: project.projectName, address: project.address },
          targetUrl: project.targetUrl, contract: structuredClone(params.contract), status: "running", startedAt: new Date().toISOString() };
        await writeJson(path.join(dir, "task.json"), task);
        let terminal;
        try {
          const model = await modelConfig(task.contract, runtime.modelRuntime);
          const state = await login(runtime, project, task.contract, signal);
          signal?.throwIfAborted();
          const located = await executeFile(runtime.node, ["-e", "process.stdout.write(require(process.argv[1]).chromium.executablePath())", path.join(runtime.modules, "@playwright/test")], {
            env: { ...process.env, PLAYWRIGHT_BROWSERS_PATH: runtime.browsers }, timeout: 10000, signal,
          });
          const chromiumPath = located.stdout;
          const probe = startProbe({ python: runtime.browserPython,
            timeoutMs: task.contract.budget.timeoutMs + 10000,
            message: { type: "start", workflow, taskId, output: dir, url: task.targetUrl,
              address: project.address, contract: task.contract, goal: task.contract.goal,
              chromium: chromiumPath, storageState: state, model,
              directModelHost: task.contract.provider === "qwen3.8-flash-next" && task.contract.modelId === "qwen3.8-flash-next" ? new URL(model.base_url).hostname : null }, onEvent });
          const abort = () => probe.cancel();
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try { terminal = (await probe.completed).terminal; }
          catch (error) {
            terminal = error.result?.terminal;
            if (!terminal?.cleanupConfirmed) root.keepLock = true;
            await writeJson(path.join(dir, "process-result.json"), error.result ?? { reason: error.message });
            throw new Error(`探索未完成：${error.message}；taskId=${taskId}`);
          } finally { signal?.removeEventListener("abort", abort); }
        } catch (error) {
          if (error.cleanupUnconfirmed) root.keepLock = true;
          await writeJson(path.join(dir, "task.json"), { ...task, status: signal?.aborted && terminal?.cleanupConfirmed ? "cancelled" : error.message.startsWith("blocked") ? "blocked" : "failed",
            reason: error.message, terminal, finishedAt: new Date().toISOString() });
          throw error;
        } finally {
          try { await fs.rm(path.join(dir, "private"), { recursive: true, force: true }); }
          catch (error) { root.keepLock = true; throw error; }
        }
        await writeJson(path.join(dir, "task.json"), { ...task, status: terminal.status, terminal, finishedAt: new Date().toISOString() });
        return { taskId, status: terminal.status, taskDirectory: dir, actions: terminal.actions };
      });
    },
    async saveCandidate(cwd, params, signal) {
      return exclusive(cwd, async (root) => {
        signal?.throwIfAborted();
        const caseId = params.caseId;
        id(caseId);
        if (!text(params.taskId)) return createRepairTask(root, { caseId, baseRevision: params.baseRevision, parentRunId: params.parentRunId });
        const { task, dir } = await boundTask(root, params.taskId);
        const repair = task.kind === "repair" ? task.repair : null;
        if (repair) check(repair.caseId === caseId, "修复任务与用例不匹配。");
        check(task.status === "completed" && task.contract.mode !== "explore", "只有允许生成候选且完成探索的任务可以保存。");
        const draft = path.join(dir, "drafts");
        const scriptFile = await fileAt(draft, caseId, "case.spec.cjs");
        const metaFile = await fileAt(draft, caseId, "case.json");
        const script = await fs.readFile(scriptFile, "utf8");
        const metaData = await fs.readFile(metaFile);
        const meta = JSON.parse(metaData);
        check(meta.schema === "qa-ui-case/v1" && meta.caseId === caseId && meta.project?.id === task.project.id &&
          meta.targetUrl === task.targetUrl && meta.role === task.contract.role, "用例身份、项目、目标和探索任务必须一致。");
        check(text(meta.title) && Array.isArray(meta.modulePath) && meta.modulePath.length > 0 && meta.modulePath.every(text), "用例缺少标题或模块。");
        for (const key of ["initialState", "dataStrategy", "cleanup"]) check(meta[key] === task.contract[key], `用例 ${key} 不能改变任务约定。`);
        check(JSON.stringify(meta.expected) === JSON.stringify(task.contract.expected), "候选不能更改已冻结的预期与来源。");
        if (task.contract.dataStrategy === "isolated-write") {
          check(JSON.stringify(meta.writeAuthorization) === JSON.stringify(task.contract.writeAuthorization), "用例写授权必须与任务约定一致。");
          check(JSON.stringify(meta.residualAuthorization) === JSON.stringify(task.contract.residualAuthorization),
            "用例残留授权必须与任务约定一致。");
        } else {
          check(meta.writeAuthorization === undefined && meta.residualAuthorization === undefined, "只读用例不能声明写操作或残留授权。");
        }
        if (repair) {
          check(meta.taskId === repair.baseTaskId, "修复候选必须保留原探索任务编号。");
          const base = await revision(root, caseId, repair.baseRevision);
          for (const key of ["title", "modulePath", "targetUrl", "role", "initialState", "dataStrategy", "cleanup", "writeAuthorization", "residualAuthorization", "expected", "steps", "assertions"]) {
            check(JSON.stringify(meta[key]) === JSON.stringify(base.meta[key]), `修复补丁不能改变 ${key}；只允许修改脚本定位、等待和证据。`);
          }
        } else {
          check(meta.taskId === params.taskId, "用例身份、项目、目标和探索任务必须一致。");
          const actions = (await fs.readFile(await fileAt(dir, "actions.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
          const known = new Set(actions.filter((item) => item.result?.length && item.result.every((result) => !result.error)).map((item) => item.stepId));
          check(Array.isArray(meta.steps) && meta.steps.length > 0 && meta.steps.every((step) => text(step.text) && known.has(step.stepId)), "每个用例步骤必须引用本任务真实成功步骤。");
        }
        check(Array.isArray(meta.assertions) && task.contract.expected.every((expected) => meta.assertions.some((item) => item.kind === "business" && item.expectedId === expected.id && text(item.text))), "每条业务预期必须有业务断言引用。");
        check((script.match(/\btest\s*\(/g) ?? []).length === 1 && /\bexpect\s*\(/.test(script), "每个脚本必须有且只有一个 test，包含明确断言。");
        check(!/\b(?:skip|fixme|fail|only|waitForTimeout|setTimeout|setInterval|nth|first|last)\s*\(|\bwhile\s*\(|\bcatch\b|\b(?:password|api_key|Authorization)\s*[:=]|element[-_]?\d+|\bref\s*[:=]\s*["']e\d+/.test(script), "发现跳过、吞异常、固定等待、任意行、临时 ref 或明显凭据。");
        const evidenceNames = ["qa-initial-state", "qa-business-result",
          ...(task.contract.dataStrategy === "isolated-write"
            ? [task.contract.cleanup === "residual" ? "qa-residue" : "qa-cleanup"] : [])];
        for (const name of evidenceNames) check(script.includes(name), `脚本必须留存 ${name} 截图证据。`);
        if (task.contract.dataStrategy === "isolated-write") {
          check(/process\.env\.QA_RUN_ID/.test(script), "隔离写脚本必须使用 QA_RUN_ID 生成每次独立的测试数据。");
          check(task.contract.cleanup === "residual" ? /qa-residue/.test(script) : /qa-cleanup/.test(script),
            task.contract.cleanup === "residual" ? "声明残留的脚本必须留存 qa-residue 证据。" : "隔离写脚本必须留存 qa-cleanup 清理证据。");
        }
        const syntax = await processRun(runtime.node, ["--check", scriptFile], signal);
        check(syntax.code === 0, "脚本语法检查未通过。");
        check(hash(await fs.readFile(scriptFile)) === hash(script) && hash(await fs.readFile(metaFile)) === hash(metaData), "静态检查期间草稿发生变化，请保留并重新检查。");
        const caseDir = await directory(root.base, "cases", caseId);
        const assetFile = path.join(caseDir, "asset.json");
        let asset;
        try { asset = await json(await fileAt(caseDir, "asset.json")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        asset ??= { schema: "qa-ui-asset/v1", caseId, revisions: [], currentRevision: null };
        check(asset.schema === "qa-ui-asset/v1" && asset.caseId === caseId, "拒绝覆盖旧格式资产。");
        if (repair) {
          check(asset.currentRevision === repair.baseRevision, "正式版本已变化，修复任务不能继续保存补丁。");
          check(asset.revisions.filter((item) => item.taskId === params.taskId).length < 2, "每个修复任务最多两个候选补丁。");
        } else {
          check(asset.revisions.length < 3 && asset.revisions.every((item) => item.taskId === params.taskId), "阶段 2 仅新建用例，同任务最多初稿及两个补丁；已有用例修复请使用修复任务。");
        }
        const number = String(asset.revisions.length + 1).padStart(4, "0");
        const revisions = await directory(caseDir, "revisions");
        const destination = path.join(revisions, number);
        await fs.mkdir(destination, { mode: 0o700 });
        const hashes = { "case.spec.cjs": hash(script), "case.json": hash(metaData) };
        await fs.writeFile(path.join(destination, "case.spec.cjs"), script, { flag: "wx" });
        await fs.writeFile(path.join(destination, "case.json"), metaData, { flag: "wx" });
        const entry = repair
          ? { revision: number, taskId: params.taskId, baseRevision: repair.baseRevision, baseTaskId: repair.baseTaskId, parentRunId: repair.parentRunId, hashes, validatedRunId: null }
          : { revision: number, taskId: params.taskId, hashes, validatedRunId: null };
        if (text(params.patchSummary)) entry.patchSummary = params.patchSummary.trim().slice(0, 300);
        asset.revisions.push(entry);
        await writeJson(assetFile, asset);
        return { caseId, revision: number, status: "candidate", hashes,
          ...(repair ? { baseRevision: repair.baseRevision, parentRunId: repair.parentRunId } : {}) };
      });
    },
    async run(cwd, { caseId, revision: number, mode }, signal) {
      return exclusive(cwd, async (root) => {
        check(["validate", "regression"].includes(mode), "执行 mode 必须为 validate 或 regression。");
        const selected = await revision(root, caseId, number);
        const result = await executeSelection(root, [selected], mode, signal);
        return { ...result, caseId, revision: number };
      });
    },
    async regress(cwd, { projectId, caseIds, all }, signal) {
      return exclusive(cwd, async (root) => {
        signal?.throwIfAborted();
        check(text(projectId), "必须选择项目。");
        check(all === true ? caseIds === undefined : Array.isArray(caseIds) && caseIds.length > 0, "请选择 caseIds 或 all，不能同时选择。");
        const names = all ? (await fs.readdir(root.caseDir, { withFileTypes: true })).filter((item) => item.isDirectory() && !item.name.startsWith(".")).map((item) => item.name).sort() : [...new Set(caseIds)];
        const selections = [];
        for (const caseId of names) {
          id(caseId);
          let asset;
          try { asset = await json(await fileAt(root.caseDir, caseId, "asset.json")); }
          catch (error) { if (all && error.code === "ENOENT") continue; throw error; }
          check(asset.schema === "qa-ui-asset/v1" && asset.caseId === caseId, "资产格式不匹配。");
          if (all && asset.currentRevision === null) continue;
          check(text(asset.currentRevision), "普通回归不能执行尚未发布的候选。");
          const selected = await revision(root, caseId, asset.currentRevision);
          if (all && selected.meta.project?.id !== projectId) continue;
          check(selected.meta.project?.id === projectId, "case 不属于所选项目。");
          selections.push(selected);
        }
        return executeSelection(root, selections, "regression", signal);
      });
    },
    async publish(cwd, { caseId, revision: number, runId }) {
      return exclusive(cwd, async (root) => {
        const selected = await revision(root, caseId, number);
        const dir = path.join(root.base, "runs");
        id(runId);
        const task = await json(await fileAt(dir, runId, "task.json"));
        check(task.workflow === workflow && task.workspace === root.workspace && task.purpose === "validate" &&
          task.caseIds.length === 1 && task.caseIds[0] === caseId && task.revisions[caseId] === number, "验证批次与指定版本不匹配。");
        const runDir = path.join(dir, runId);
        const manifest = await json(await fileAt(runDir, "manifest.json"));
        check(manifest.runId === runId && manifest.files.length > 0, "缺少执行清单。");
        for (const item of manifest.files) {
          check(typeof item.path === "string" && !path.isAbsolute(item.path) && item.path.split("/").every((part) => part && part !== ".." && part !== "."), "执行清单路径无效。");
          const data = await fs.readFile(await fileAt(runDir, ...item.path.split("/")));
          check(data.length === item.bytes && hash(data) === item.sha256, "执行证据或报告已变更，不能发布。");
        }
        for (const name of ["summary.json", "results.json", "html/index.html"]) check(manifest.files.some((item) => item.path === name), "原生报告或摘要未纳入清单。");
        const summary = await json(await fileAt(runDir, "summary.json"));
        const native = await json(await fileAt(runDir, "results.json"));
        const tests = testsIn(native.suites ?? []);
        check(summary.workflow === workflow && summary.status === "passed" && summary.exitCode === 0 && summary.problems.length === 0 &&
          summary.cleanup === "deleted" && task.status === "passed" && selected.entry.validationRunId === runId && tests.length === 1 && tests[0].status === "passed" && native.errors?.length === 0 &&
          native.stats?.expected === 1 && ["unexpected", "flaky", "skipped"].every((key) => native.stats[key] === 0), "只有一个实际 passed、退出 0 且收尾完整的验证才能发布。");
        check(path.resolve(root.caseDir, tests[0].file) === selected.files["case.spec.cjs"], "原生结果未对应指定脚本。");
        for (const [name, file] of Object.entries(selected.files)) {
          const version = summary.versions.files.find((item) => item.path === file);
          check(version?.sha256 === selected.entry.hashes[name] && version.afterSha256 === version.sha256 && task.caseHashes[file] === version.sha256, "执行快照与版本哈希不一致。");
          const index = summary.versions.files.indexOf(version) + 1;
          const snapshot = `sources/${index}-${name}`;
          check(manifest.files.some((item) => item.path === snapshot && item.sha256 === version.sha256), "缺少准确版本快照。");
        }
        for (const name of ["qa-initial-state", "qa-business-result",
          ...(task.dataStrategy === "isolated-write" ? [task.dataCleanup === "residual" ? "qa-residue" : "qa-cleanup"] : [])]) {
          const attachment = tests[0].attachments.find((item) => item.name === name && item.contentType === "image/png" && item.path);
          check(attachment, "缺少初态或业务结果截图。");
          const relative = path.relative(runDir, attachment.path).split(path.sep).join("/");
          check(manifest.files.some((item) => item.path === relative && item.bytes > 0), "必要截图未纳入证据清单。");
        }
        selected.entry.validatedRunId = runId;
        selected.asset.currentRevision = number;
        await writeJson(path.join(root.caseDir, caseId, "asset.json"), selected.asset);
        return { caseId, revision: number, runId, status: "verified" };
      });
    },
  };
}
