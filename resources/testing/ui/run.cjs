const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { spawn } = require("node:child_process");
const { createWriteStream } = require("node:fs");

const digest = (data) => createHash("sha256").update(data).digest("hex");
const writeJson = (file, value) => fs.writeFile(file, JSON.stringify(value, null, 2) + "\n");

function testsIn(suites, parents = []) {
  return suites.flatMap((suite) => {
    const titles = [...parents, suite.title].filter(Boolean);
    return [
      ...(suite.specs ?? []).flatMap((spec) => spec.tests.map((test) => {
        const result = test.results?.at(-1);
        const status = test.status === "flaky" ? "flaky"
          : test.status === "expected" && test.expectedStatus !== "passed" && result?.status !== "skipped" ? "expected-failure"
          : result?.status === "interrupted" ? "cancelled"
          : ["failed", "timedOut"].includes(result?.status) ? "failed"
          : result?.status ?? "not-run";
        return {
          file: spec.file, line: spec.line, title: [...titles, spec.title].join(" > "),
          project: test.projectName, status, durationMs: result?.duration ?? null,
          errors: result?.errors ?? [], attachments: result?.attachments ?? [],
        };
      })),
      ...testsIn(suite.suites ?? [], titles),
    ];
  });
}

async function inventory(directory, base = directory) {
  const entries = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, item.name);
    if (item.isDirectory()) entries.push(...await inventory(file, base));
    else if (item.isFile() && !["task.json", "manifest.json"].includes(item.name)) {
      const data = await fs.readFile(file);
      entries.push({ path: path.relative(base, file).split(path.sep).join("/"), bytes: data.length, sha256: digest(data) });
    }
  }
  return entries;
}

async function run(taskFile) {
  const task = JSON.parse(await fs.readFile(taskFile, "utf8"));
  if (task.mode !== "run") throw new Error("请先用 run 模式准备正式批次。");
  // 独占标记保留在批次内；禁止相同批次被重复执行或覆盖。
  const lock = await fs.open(path.join(task.runDir, ".started"), "wx");
  await lock.close();
  let child;
  let cancelled = false;
  let killTimer;
  const cancel = () => {
    cancelled = true;
    child?.kill("SIGINT");
    killTimer ??= setTimeout(() => child?.kill("SIGKILL"), 5000);
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const startedAt = new Date().toISOString();
  let exitCode = null;
  let report;
  const problems = [];
  const versions = { node: process.version, playwright: null, files: [] };
  let cleanup = task.authDirectory ? "pending" : "not-needed";
  try {
    versions.playwright = require("@playwright/test/package.json").version;
    await writeJson(taskFile, { ...task, status: "running", startedAt });
    await fs.mkdir(path.join(task.runDir, "sources"));
    for (const file of [...task.caseFiles, ...(task.assetFiles ?? []), task.config, path.join(__dirname, "playwright-resolve.cjs"), __filename]) {
      const data = await fs.readFile(file);
      versions.files.push({ path: file, sha256: digest(data) });
      await fs.writeFile(path.join(task.runDir, "sources", `${versions.files.length}-${path.basename(file)}`), data);
      if (task.caseHashes?.[file] && task.caseHashes[file] !== digest(data)) {
        throw new Error(`准备后脚本已变更，请重新准备批次：${path.basename(file)}`);
      }
    }
    const stdout = createWriteStream(path.join(task.runDir, "stdout.log"));
    const stderr = createWriteStream(path.join(task.runDir, "stderr.log"));
    const filters = task.caseFiles.map((file) => file.split(path.sep).join("/").replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$");
    const testArgs = ["--require", path.join(__dirname, "playwright-resolve.cjs"), task.testCli, "test", ...filters, "--config", task.config, "--project=chromium"];
    if (typeof task.grep === "string" && task.grep.trim()) {
      testArgs.push("--grep", task.grep);
    }
    try {
      exitCode = await new Promise((resolve, reject) => {
        child = spawn(process.execPath, testArgs, {
          cwd: task.workspace,
          env: {
            ...process.env, NODE_PATH: task.modules, PLAYWRIGHT_BROWSERS_PATH: task.browsers,
            QA_TARGET_URL: task.targetUrl, QA_UI_CASES_DIR: task.caseDir,
            QA_UI_OUTPUT_DIR: task.runDir, QA_UI_PHASE: "run",
            QA_UI_STORAGE_STATE: task.authFile || "", QA_UI_HEADED: "0",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        child.stdout.pipe(stdout);
        child.stderr.pipe(stderr);
        child.once("error", reject);
        child.once("close", (code) => resolve(code));
        if (cancelled) cancel();
      });
    } finally {
      await Promise.all([stdout, stderr].map((stream) => new Promise((resolve) => {
        if (stream.writableFinished) resolve();
        else stream.end(resolve);
      })));
    }
    const parsed = JSON.parse(await fs.readFile(task.resultsFile, "utf8"));
    if (!Array.isArray(parsed.suites) || !Array.isArray(parsed.errors) || !parsed.stats) {
      throw new Error("原生报告结构不完整。");
    }
    report = parsed;
    problems.push(...report.errors.map((error) => error.message || "原生执行错误"));
    await fs.access(task.htmlReport);
  } catch (error) {
    problems.push(error.message);
  } finally {
    clearTimeout(killTimer);
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    if (task.authDirectory) {
      try {
        await fs.rm(task.authDirectory, { recursive: true, force: true });
        cleanup = "deleted";
      } catch (error) {
        cleanup = "failed";
        problems.push(`登录态清理失败：${error.message}`);
      }
    }
  }
  for (const version of versions.files) {
    try {
      version.afterSha256 = digest(await fs.readFile(version.path));
      if (version.afterSha256 !== version.sha256) problems.push(`执行期间文件发生变更：${version.path}`);
    } catch {
      problems.push(`执行后文件不可读：${version.path}`);
    }
  }
  const tests = testsIn(report?.suites ?? []);
  if (report) {
    const reportedTotal = ["expected", "unexpected", "flaky", "skipped"].reduce((sum, key) => sum + (report.stats[key] ?? 0), 0);
    if (reportedTotal !== tests.length) problems.push("原生统计与逐例结果数量不一致。");
    for (const file of task.caseFiles) {
      if (!tests.some((test) => path.resolve(task.caseDir, test.file) === file)) {
        problems.push(`所选脚本没有测试结果：${file}`);
      }
    }
  }
  for (const test of tests) {
    for (const attachment of test.attachments) {
      if (!attachment.path) continue;
      try { await fs.access(attachment.path); }
      catch { problems.push(`证据缺失：${attachment.path}`); }
    }
  }
  const counts = {};
  if (task.workflow === "browser-use-playwright") {
    if (tests.length !== task.caseFiles.length || task.caseFiles.some((file) => tests.filter((test) => path.resolve(task.caseDir, test.file) === file).length !== 1)) {
      problems.push("每个版本必须有且只有一个实际测试结果。");
    }
    for (const test of tests.filter((item) => item.status === "passed")) {
      for (const name of ["qa-initial-state", "qa-business-result"]) {
        if (!test.attachments.some((item) => item.name === name && item.contentType === "image/png" && item.path)) {
          problems.push(`缺少必要截图：${name}`);
        }
      }
    }
  }
  for (const test of tests) counts[test.status] = (counts[test.status] ?? 0) + 1;
  const passed = exitCode === 0 && !cancelled && problems.length === 0 && tests.length > 0 && tests.every((test) => test.status === "passed");
  const summary = {
    schema: "qa-report/v1",
    kind: "ui",
    ...(task.workflow ? { workflow: task.workflow, purpose: task.purpose, revisions: task.revisions, sourceTaskIds: task.sourceTaskIds, caseModules: task.caseModules } : {}),
    runId: task.runId, status: cancelled ? "cancelled" : passed ? "passed" : report && problems.length === 0 ? "failed" : "incomplete",
    startedAt, finishedAt: new Date().toISOString(), targetUrl: task.targetUrl,
    project: task.project ?? null, workspace: task.workspace, dataDir: task.dataDir ?? null,
    caseIds: task.caseIds, testCount: report ? tests.length : null, counts,
    exitCode, cleanup, problems, versions, tests,
    tracePolicy: task.authFile ? "disabled-for-private-auth" : "steps-without-dom-network-sources",
    limits: "版本清单覆盖所选脚本、配置和执行器，不覆盖导入依赖闭包；被测部署版本未知。",
  };
  await writeJson(task.summaryFile, summary);
  await fs.writeFile(task.summaryDocument, [
    `# UI 测试批次 ${task.runId}`, "", `状态：${summary.status}；用例数：${summary.testCount ?? "未知"}；登录态清理：${cleanup}。`,
    `项目：${task.project?.name ?? "未登记"}；工作区：${task.workspace}。`,
    `范围：${task.caseIds.join(", ")}。统计：${JSON.stringify(counts)}。`, "",
    `运行环境：Node ${versions.node}；Playwright ${versions.playwright ?? "未知"}。`,
    task.authFile ? "本批次关闭 trace，避免归档私有登录态。" : "trace 保留步骤，不含 DOM、网络快照和源码。", "",
    "| 用例 | 状态 | 耗时（毫秒） |", "| --- | --- | --- |",
    ...tests.map((test) => `| ${test.title.replaceAll("|", "\\|").replaceAll("\n", " ")} | ${test.status} | ${test.durationMs ?? "未知"} |`),
    "", ...problems.map((problem) => `- ${problem}`), "", summary.limits,
    "", "原生报告：results.json、html/index.html；版本和逐例证据引用：summary.json；文件摘要：manifest.json。", "",
  ].join("\n"));
  await writeJson(task.manifestFile, { runId: task.runId, files: await inventory(task.runDir) });
  await writeJson(taskFile, { ...task, authFile: undefined, authDirectory: undefined, status: summary.status, startedAt, finishedAt: summary.finishedAt });
  process.stdout.write(JSON.stringify({ status: summary.status, summaryFile: task.summaryFile, cleanup }) + "\n");
  process.exitCode = passed ? 0 : 1;
}

if (require.main === module) run(process.argv[2]).catch((error) => {
  process.stderr.write(error.message + "\n");
  process.exitCode = 1;
});
module.exports = { testsIn };
