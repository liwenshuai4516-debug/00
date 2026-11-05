#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { randomUUID, createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { chromium } = require("@playwright/test");

const uiDir = __dirname;
const repoRoot = path.resolve(uiDir, "../../..");
const runtime = {
  testCli: path.join(uiDir, "node_modules/@playwright/test/cli.js"),
  config: path.join(uiDir, "playwright.config.cjs"),
  modules: path.join(uiDir, "node_modules"),
  browsers: path.join(uiDir, "browsers"),
  runner: path.join(uiDir, "run.cjs"),
};
const digest = (data) => createHash("sha256").update(data).digest("hex");

function usage() {
  return [
    "用法: execute.cjs --project <编号|名称> (--cases id1,id2 | --all) [选项]",
    "",
    "选项:",
    "  --url <地址>           覆盖项目配置中的目标地址（必须同源）",
    "  --config <文件>        项目配置文件，默认 config/projects.local.json",
    "  --storage-state <文件>  复用已有登录态；不传则用配置凭据无头登录",
    "  --tenant <名称>        登录后租户名称，默认 项目管理",
    "  --grep <正则>          只运行标题匹配的测试（单条用例复测用）",
    "  --headed               登录窗口可见（调试用）",
    "  --help                 显示帮助",
    "",
    "输出: 最后一行 JSON（status、summaryFile、testCount、counts）。",
    "退出码: 0 全部通过；1 失败、incomplete 或参数/环境错误。",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { cases: null, all: false, headed: false, tenant: "项目管理" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (arg === "--headed") options.headed = true;
    else if (arg === "--project") options.project = argv[++index];
    else if (arg === "--cases") options.cases = argv[++index];
    else if (arg === "--url") options.url = argv[++index];
    else if (arg === "--config") options.config = argv[++index];
    else if (arg === "--storage-state") options.storageState = argv[++index];
    else if (arg === "--tenant") options.tenant = argv[++index];
    else if (arg === "--grep") options.grep = argv[++index];
    else throw new Error(`未知参数：${arg}`);
  }
  if (options.help) return options;
  if (!options.project) throw new Error("缺少 --project。");
  if (!options.all && !options.cases) throw new Error("缺少 --cases 或 --all。");
  if (options.all && options.cases) throw new Error("--cases 与 --all 不能同时使用。");
  if (options.all && options.grep) throw new Error("--all 与 --grep 不能同时使用；条件复测用 --cases，全量复测用 --all。");
  if (options.grep !== undefined && (typeof options.grep !== "string" || !options.grep.trim())) {
    throw new Error("--grep 不能为空。");
  }
  return options;
}

async function loadProject(options) {
  const configPath = path.resolve(options.config ?? path.join(repoRoot, "config/projects.local.json"));
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  const projects = Array.isArray(config.projects) ? config.projects : [];
  const project = projects.find((item) => item.id === options.project || item.name === options.project);
  if (!project) throw new Error(`未找到项目：${options.project}`);
  if (!project.workspaceDir) throw new Error("项目没有工作目录。");
  const workspace = await fs.realpath(project.workspaceDir);
  let targetUrl = options.url ?? null;
  let target = null;
  if (targetUrl) {
    target = new URL(targetUrl);
    if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) throw new Error("目标地址必须是 HTTP/HTTPS 且不能包含账号密码。");
    if (project.address) {
      const base = new URL(project.address);
      if (base.origin !== target.origin) throw new Error("--url 与项目配置不同源。");
    }
    targetUrl = target.href;
  }
  return { project, workspace, targetUrl, target, configPath };
}

async function loadCases(projectInfo, options) {
  const { project, workspace } = projectInfo;
  const caseDir = path.join(workspace, "qa/data/ui/cases");
  let caseIds;
  if (options.all) {
    caseIds = [];
    for (const name of (await fs.readdir(caseDir)).filter((entry) => entry.endsWith(".asset.json")).sort()) {
      const caseId = name.slice(0, -".asset.json".length);
      let asset;
      try { asset = JSON.parse(await fs.readFile(path.join(caseDir, name), "utf8")); }
      catch { continue; }
      if (asset.projectId !== project.id) continue;
      if (projectInfo.targetUrl && asset.targetUrl !== projectInfo.targetUrl) continue;
      caseIds.push(caseId);
    }
  } else {
    caseIds = [...new Set(options.cases.split(",").map((item) => item.trim()).filter(Boolean))];
  }
  if (caseIds.length === 0) throw new Error("没有可执行的 case。");

  const selected = [];
  const targets = new Set();
  for (const caseId of caseIds) {
    if (!/^[\p{L}\p{N}_-]{1,180}$/u.test(caseId)) throw new Error(`caseId 不合法：${caseId}`);
    const assetPath = path.join(caseDir, `${caseId}.asset.json`);
    const specPath = path.join(caseDir, `${caseId}.spec.cjs`);
    const documentPath = path.join(caseDir, `${caseId}.md`);
    let asset;
    try { asset = JSON.parse(await fs.readFile(assetPath, "utf8")); }
    catch { throw new Error(`找不到或无法读取资产：${caseId}`); }
    if (asset.projectId !== project.id) throw new Error(`case 不属于项目 ${project.id}：${caseId}`);
    if (projectInfo.targetUrl && asset.targetUrl !== projectInfo.targetUrl) throw new Error(`case 的目标地址与本次执行不一致：${caseId}`);
    targets.add(asset.targetUrl);
    selected.push({ caseId, assetPath, specPath, documentPath });
  }
  if (!projectInfo.targetUrl) {
    if (targets.size !== 1) throw new Error("所选 case 的目标地址不一致，请用 --url 指定。");
    projectInfo.targetUrl = [...targets][0];
    projectInfo.target = new URL(projectInfo.targetUrl);
    if (project.address) {
      const base = new URL(project.address);
      if (base.origin !== projectInfo.target.origin) throw new Error("用例目标地址与项目配置不同源。");
    }
  }

  const caseFiles = [];
  const assetFiles = [];
  const caseHashes = {};
  for (const { caseId, assetPath, specPath, documentPath } of selected) {
    const asset = JSON.parse(await fs.readFile(assetPath, "utf8"));
    const spec = await fs.readFile(specPath);
    if (asset.sha256 !== digest(spec)) throw new Error(`case 脚本与登记版本不一致，请重新 finalize：${caseId}`);
    await fs.access(documentPath);
    caseFiles.push(specPath);
    assetFiles.push(assetPath, documentPath);
    caseHashes[specPath] = digest(spec);
  }
  return { caseDir, caseIds, caseFiles, assetFiles, caseHashes };
}

async function login({ project, target, targetUrl }, options, temporary) {
  if (options.storageState) {
    const file = path.resolve(options.storageState);
    await fs.access(file);
    return { file, directory: null };
  }
  if (!project.account || !project.password) throw new Error("项目未配置账号密码；请传 --storage-state。");
  const directory = await fs.mkdtemp(path.join(temporary, "auth-"));
  await fs.chmod(directory, 0o700);
  const file = path.join(directory, "state.json");
  const browser = await chromium.launch({ headless: !options.headed });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);
    const password = page.locator('input[type="password"]').filter({ visible: true });
    if (await password.count() > 0) {
      if (await page.locator('input[autocomplete="one-time-code"],input[placeholder*="验证码"],input[name*="captcha" i]').filter({ visible: true }).count()) {
        throw new Error("登录需要验证码，请用 --storage-state 提供已登录状态。");
      }
      const account = page.locator('input[autocomplete="username"],input[name="username"],input[name="account"],input[type="email"],input[placeholder*="账号"],input[placeholder*="用户名"]').filter({ visible: true });
      const submit = page.getByRole("button", { name: /^\s*(登\s*录|登录系统|login|sign in)\s*$/i });
      if (await account.count() !== 1 || await password.count() !== 1 || await submit.count() !== 1) throw new Error("无法唯一识别登录表单；请传 --storage-state。");
      await account.fill(project.account);
      await password.fill(project.password);
      await submit.click();
      await page.waitForTimeout(2500);
      if (page.url().includes("/tenant/switch")) {
        const tenant = page.getByText(options.tenant, { exact: true }).first();
        if (await tenant.count()) { await tenant.click(); await page.waitForTimeout(800); }
        const choose = page.getByText("立即选择", { exact: true }).first();
        if (await choose.count()) { await choose.click(); await page.waitForTimeout(1500); }
      }
      if (await page.locator('input[type="password"]').filter({ visible: true }).count() > 0) throw new Error("自动登录未通过，请传 --storage-state。");
      await page.goto(targetUrl, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1000);
    }
    const state = await context.storageState({ indexedDB: true });
    state.origins = state.origins.filter((item) => item.origin === target.origin);
    state.cookies = state.cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "");
      return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
    });
    await fs.writeFile(file, JSON.stringify(state), { mode: 0o600 });
    await fs.chmod(file, 0o600);
    await context.close();
    return { file, directory };
  } catch (error) {
    await browser.close().catch(() => {});
    await fs.rm(directory, { recursive: true, force: true }).catch(() => {});
    throw error;
  } finally {
    await browser.close().catch(() => {});
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) { process.stdout.write(usage() + "\n"); return 0; }
  const projectInfo = await loadProject(options);
  const cases = await loadCases(projectInfo, options);
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "qa-ui-execute-"));
  let auth = null;
  let child = null;
  try {
    auth = await login(projectInfo, options, tempRoot);
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const runId = `execute-${stamp}-${randomUUID().slice(0, 8)}`;
    const runDir = path.join(projectInfo.workspace, "qa/ui/runs", runId);
    await fs.mkdir(runDir, { recursive: true });
    const task = {
      mode: "run",
      runId,
      runDir,
      workspace: projectInfo.workspace,
      project: { id: projectInfo.project.id, name: projectInfo.project.name, address: projectInfo.project.address },
      dataDir: path.join(projectInfo.workspace, "qa/data"),
      caseDir: cases.caseDir,
      caseIds: cases.caseIds,
      caseFiles: cases.caseFiles,
      assetFiles: cases.assetFiles,
      caseHashes: cases.caseHashes,
      grep: options.grep?.trim() || null,
      targetUrl: projectInfo.targetUrl,
      config: runtime.config,
      testCli: runtime.testCli,
      modules: runtime.modules,
      browsers: runtime.browsers,
      authFile: auth.file,
      authDirectory: auth.directory,
      resultsFile: path.join(runDir, "results.json"),
      htmlReport: path.join(runDir, "html/index.html"),
      summaryFile: path.join(runDir, "summary.json"),
      summaryDocument: path.join(runDir, "summary.md"),
      manifestFile: path.join(runDir, "manifest.json"),
    };
    const taskFile = path.join(runDir, "task.json");
    await fs.writeFile(taskFile, JSON.stringify(task, null, 2) + "\n", { mode: 0o600 });
    child = spawn(process.execPath, [runtime.runner, taskFile], {
      cwd: projectInfo.workspace,
      env: { ...process.env, NODE_PATH: runtime.modules, PLAYWRIGHT_BROWSERS_PATH: runtime.browsers },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => { output += chunk.toString(); });
    child.stderr.on("data", (chunk) => process.stderr.write(chunk));
    const code = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", resolve);
    });
    const lines = output.trim().split("\n").filter(Boolean);
    const last = lines.at(-1);
    if (!last) throw new Error("执行器没有返回结果。");
    const result = JSON.parse(last);
    const summary = JSON.parse(await fs.readFile(result.summaryFile, "utf8"));
    process.stdout.write(JSON.stringify({
      status: summary.status,
      summaryFile: result.summaryFile,
      testCount: summary.testCount,
      counts: summary.counts,
      exitCode: code,
      cleanup: summary.cleanup,
      problems: summary.problems,
    }) + "\n");
    return code === 0 && summary.status === "passed" ? 0 : 1;
  } finally {
    if (auth?.directory) await fs.rm(auth.directory, { recursive: true, force: true }).catch(() => {});
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {});
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`执行失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
module.exports = { parseArgs, loadProject, loadCases };
