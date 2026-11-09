#!/usr/bin/env node
const fs = require("node:fs/promises");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createProjectStore } = require("../../../src/main/storage/project-store.js");
const { resolveUiTestingRuntime } = require("../../../src/main/capabilities/ui-testing/runtime-paths.js");

const repoRoot = path.resolve(__dirname, "../../..");

function usage() {
  return [
    "用法: execute.cjs --project <编号|名称> (--cases id1,id2 | --all) [--config <文件>]",
    "",
    "只执行 qa/ui/cases/<caseId>/asset.json 的 currentRevision；候选不能用于普通回归。",
    "--all 选择所选项目的全部正式用例；目标地址、角色和身份标识必须一致。",
    "--config 默认 config/projects.local.json；后台登录使用项目已配置账号。",
    "不读取 .env、不调用模型、不修改资产；SIGINT/SIGTERM 交给共享执行器取消并收尾。",
    "输出: 最后一行 JSON（runId、status、revisions、summaryFile、testCount、counts、cleanup）。",
    "退出码: 0 全部通过；1 失败、取消、incomplete 或参数/环境错误。",
  ].join("\n");
}

function parseArgs(argv) {
  const options = { all: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help") options.help = true;
    else if (arg === "--all") options.all = true;
    else if (["--project", "--cases", "--config"].includes(arg)) {
      const value = argv[++index];
      if (!value?.trim() || value.startsWith("--")) throw new Error(`${arg} 缺少参数值。`);
      const key = arg.slice(2);
      if (options[key] !== undefined) throw new Error(`${arg} 不能重复。`);
      options[key] = value;
    } else throw new Error(`未知参数：${arg}`);
  }
  if (options.help) return options;
  if (!options.project) throw new Error("缺少 --project。");
  if (options.all && options.cases !== undefined) throw new Error("--cases 与 --all 不能同时使用。");
  if (!options.all && options.cases === undefined) throw new Error("缺少 --cases 或 --all。");
  if (options.cases !== undefined) {
    options.caseIds = [...new Set(options.cases.split(",").map((item) => item.trim()))];
    if (!options.caseIds.every((item) => /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(item))) throw new Error("caseId 无效。");
  }
  return options;
}

async function loadProject(options) {
  const configPath = path.resolve(options.config ?? path.join(repoRoot, "config/projects.local.json"));
  const projects = await createProjectStore(configPath).list();
  const exact = projects.find((item) => item.id === options.project);
  const matches = exact ? [exact] : projects.filter((item) => item.name === options.project);
  if (matches.length !== 1) throw new Error("未找到唯一项目，请使用明确的项目编号。");
  const project = matches[0];
  const workspace = await fs.realpath(project.workspaceDir);
  if (!(await fs.stat(workspace)).isDirectory()) throw new Error("项目工作目录不是目录。");
  return { projectId: project.id, workspace, configPath };
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) { process.stdout.write(usage() + "\n"); return 0; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    const { projectId, workspace, configPath } = await loadProject(options);
    const runtime = { ...resolveUiTestingRuntime({ isPackaged: false }, repoRoot), projectConfig: configPath };
    const { createReadOnlyWorkflow } = await import(pathToFileURL(path.join(repoRoot, "src/main/capabilities/ui-testing/workflow.mjs")).href);
    const result = await createReadOnlyWorkflow(runtime).regress(workspace, {
      projectId, caseIds: options.caseIds, all: options.all,
    }, controller.signal);
    process.stdout.write(JSON.stringify(result) + "\n");
    return result.status === "passed" ? 0 : 1;
  } finally {
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
  }
}

if (require.main === module) {
  main().then((code) => { process.exitCode = code; }).catch((error) => {
    process.stderr.write(`执行失败：${error.message}\n`);
    process.exitCode = 1;
  });
}
module.exports = { parseArgs, loadProject };
