import path from "node:path";
import { realpath, stat, mkdir, writeFile, unlink } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import projectStorage from "../../storage/project-store.js";

export function matchesAddress(address, targetUrl) {
  const base = new URL(address);
  const target = new URL(targetUrl);
  const prefix = base.pathname.replace(/\/$/, "");
  return base.origin === target.origin &&
    (!prefix || target.pathname === prefix || target.pathname.startsWith(prefix + "/"));
}

export async function prepareDataDirectory(cwd, expectedWorkspaceRoot) {
  if (!cwd || !path.isAbsolute(cwd)) throw new Error("未取得当前会话工作区，请先选择工作区。");
  const workspace = await realpath(cwd);
  if (!(await stat(workspace)).isDirectory()) throw new Error("当前工作区不是目录。");
  if (expectedWorkspaceRoot && workspace !== await realpath(expectedWorkspaceRoot)) {
    throw new Error("当前工作区与本次测试预期不一致。");
  }
  const inside = (value) => {
    const relative = path.relative(workspace, value);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error("测试数据目录不能通过链接指向工作区外部。");
    }
  };
  const createdDirectories = [];
  let current = workspace;
  for (const part of ["qa", "data", "ui", "cases"]) {
    current = path.join(current, part);
    try {
      const resolved = await realpath(current);
      inside(resolved);
      if (!(await stat(resolved)).isDirectory()) throw new Error("测试数据路径存在同名文件。");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // 非递归创建：悬空链接或并发冲突不能绕过路径检查。
      try {
        await mkdir(current);
        createdDirectories.push(current);
      } catch (creationError) {
        if (creationError.code !== "EEXIST") throw creationError;
      }
    }
    current = await realpath(current);
    inside(current);
  }
  const probe = path.join(current, `.write-probe-${randomUUID()}`);
  await writeFile(probe, "", { flag: "wx" });
  await unlink(probe);
  return {
    workspace,
    workspaceRoot: workspace,
    dataDir: path.join(workspace, "qa/data"),
    caseDir: current,
    workspaceStatus: "ready",
    directoryAction: createdDirectories.length > 0 ? "created" : "reused",
    createdDirectories,
    cleanupPending: [],
  };
}

export async function resolveProject(runtime, { targetUrl, projectId, projectName, expectedWorkspaceRoot }, cwd, prepare = prepareDataDirectory) {
  if (!runtime.projectConfig) throw new Error("宿主尚未接入项目数据配置。");
  const target = new URL(targetUrl);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password) {
    throw new Error("测试地址必须使用 HTTP/HTTPS，且不能内嵌账号密码。");
  }
  const directories = await prepare(cwd, expectedWorkspaceRoot);
  const store = projectStorage.createProjectStore(runtime.projectConfig);
  const projects = await store.list();
  const candidates = [];
  for (const project of projects) {
    if (projectId && project.id !== projectId) continue;
    const data = await store.readData(project.id);
    if (data.address && matchesAddress(data.address, targetUrl)) {
      candidates.push({ project, data, specificity: new URL(data.address).pathname.replace(/\/$/, "").length });
    }
  }
  candidates.sort((left, right) => right.specificity - left.specificity);
  if (!candidates.length) throw new Error("没有与该地址匹配的项目配置，请配置项目地址或检查所选项目。");
  if (candidates[1]?.specificity === candidates[0].specificity) {
    throw new Error("该地址匹配多个项目，请明确 projectId，不能自动选择账号。");
  }
  const { project, data } = candidates[0];
  if (projectName && projectName !== data.name) throw new Error("用户提供的项目名称与地址匹配结果不一致，请核对项目。");
  const clean = (value) => {
    const text = value.normalize("NFC").replace(/[^\p{L}\p{N}_-]+/gu, "_").replace(/^_+|_+$/g, "");
    let name = "";
    for (const character of text) {
      if (name.length >= 60 || Buffer.byteLength(name + character) > 64) break;
      name += character;
    }
    return name || "root";
  };
  const route = target.pathname + (target.hash.startsWith("#/") ? target.hash.slice(1) : "");
  const suffix = createHash("sha256").update(project.id + target.origin + route).digest("hex").slice(0, 10);
  const assetName = `${clean(data.name)}__${clean(route)}__${suffix}`;
  return {
    ...directories, projectId: project.id, projectName: data.name,
    projectWorkspace: project.workspaceDir,
    address: data.address, targetUrl: target.href, assetName,
    credentialsConfigured: Boolean(data.account && data.password),
    missingConfiguration: [!data.account && "account", !data.password && "password"].filter(Boolean),
    businessDataStatus: "not-validated",
  };
}

export async function readCredentials(runtime, project) {
  const store = projectStorage.createProjectStore(runtime.projectConfig);
  const data = await store.readData(project.projectId);
  if (data.name !== project.projectName || data.address !== project.address || !matchesAddress(data.address, project.targetUrl)) {
    throw new Error("项目配置已变更，请重新检查项目后再登录。");
  }
  return { account: data.account, password: data.password };
}
