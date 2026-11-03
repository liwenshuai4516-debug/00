// 显式执行的远程验收，不属于 npm test；只使用临时 Pi 配置与安装目录。
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { DefaultPackageManager, SettingsManager } from "@mariozechner/pi-coding-agent";

const source = process.argv[2];
if (!source) throw new Error("请传入 Git 或 npm 包来源。");
const temporary = await mkdtemp(path.join(os.tmpdir(), "pi-remote-acceptance-"));
const cwd = path.join(temporary, "workspace"), agentDir = path.join(temporary, "agent");
await mkdir(cwd);
const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const manager = new DefaultPackageManager({ cwd, agentDir, settingsManager: settings });
const report = { source, steps: [], status: "blocked" };
manager.setProgressCallback(event => console.log(`${event.action}: ${event.type}`));
try {
  await manager.installAndPersist(source);
  await settings.flush();
  const configured = manager.listConfiguredPackages().find(item => item.source === source);
  if (!configured?.installedPath) throw new Error("安装未形成有效登记。");
  report.steps.push("install-and-persist");
  const resolved = await manager.resolve();
  // resolve 同时包含顶层资源；只统计所验收包的资源，不把个人技能算入远程包。
  report.resources = Object.fromEntries(Object.entries(resolved).map(([key, value]) => [key,
    value.filter(item => item.metadata.origin === "package" && item.metadata.source === source).length,
  ]));
  report.steps.push("resolve");
  const gitHead = async () => (await promisify(execFile)("git", ["rev-parse", "HEAD"], { cwd: configured.installedPath })).stdout.trim();
  const before = source.startsWith("git:") ? await gitHead() : undefined;
  await manager.update(source);
  if (before && before !== await gitHead()) throw new Error("固定 ref 更新后发生移动。");
  report.steps.push("update");
  await manager.checkForAvailableUpdates();
  report.steps.push("check-updates");
  await manager.removeAndPersist(source);
  await settings.flush();
  if (manager.listConfiguredPackages().some(item => item.source === source)) throw new Error("移除后仍有登记。");
  report.steps.push("remove-and-persist");
  report.status = "passed";
} catch (error) {
  // 远程工具可能把 URL 凭据放入异常，不保存完整错误正文。
  report.errorType = error.name;
  report.status = "blocked";
  process.exitCode = 1;
} finally {
  if (process.env.PI_ACCEPTANCE_REPORT) await writeFile(process.env.PI_ACCEPTANCE_REPORT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report));
  await rm(temporary, { recursive: true, force: true });
}
