const path = require("node:path");
const fs = require("node:fs/promises");
const { createHash, randomUUID } = require("node:crypto");

const PAGE_SIZE = 50;
const MAX_FOLDER_DEPTH = 8;
const MAX_FOLDER_PART = 80;
const MAX_FOLDER_PATH = 640;
const hash = (data) => createHash("sha256").update(data).digest("hex");
const validId = (value) => typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value);
function check(condition, message) { if (!condition) throw new Error(message); }

// 用例目录沿用 case.json 的 modulePath：既兼容已有资产，也允许模型用
// ["合同管理", "经营合同"] 或 "合同管理/经营合同" 表达层级。
function folderPathOf(meta) {
  const parts = [];
  for (const value of meta.modulePath ?? []) {
    if (typeof value !== "string") continue;
    for (const piece of value.split("/")) {
      const part = piece.trim();
      if (part && parts.length < MAX_FOLDER_DEPTH) parts.push(part.slice(0, MAX_FOLDER_PART));
    }
  }
  return parts.length > 0 ? parts : ["未分类"];
}

function parseFolder(value) {
  if (value === undefined || value === null || value === "") return [];
  check(typeof value === "string" && value.length <= MAX_FOLDER_PATH, "用例目录参数无效。");
  const parts = value.split("/").map((part) => part.trim());
  check(parts.length <= MAX_FOLDER_DEPTH && parts.every((part) =>
    part && part.length <= MAX_FOLDER_PART && part !== "." && part !== ".." && !part.includes("\0")), "用例目录参数无效。");
  return parts;
}

function inFolder(pathParts, folder) {
  return folder.length <= pathParts.length && folder.every((part, index) => pathParts[index] === part);
}

// 组织目录保存在 asset.json，不改变 revision 内容；旧资产没有该字段时沿用 modulePath。
function storedFolder(asset) {
  try {
    if (Array.isArray(asset.folder)) return asset.folder.length > 0 ? parseFolder(asset.folder.join("/")) : null;
    if (typeof asset.folder === "string" && asset.folder.trim()) return parseFolder(asset.folder);
  } catch {
    // 损坏的组织目录不影响版本读取，回退到 modulePath。
  }
  return null;
}

function folderTree(cases) {
  const root = { children: new Map(), count: 0, verified: 0, candidates: 0 };
  for (const item of cases) {
    let node = root;
    for (let index = 0; index < item.folderPath.length; index += 1) {
      const name = item.folderPath[index];
      let child = node.children.get(name);
      if (!child) {
        child = { name, path: item.folderPath.slice(0, index + 1), children: new Map(), count: 0, verified: 0, candidates: 0 };
        node.children.set(name, child);
      }
      node = child;
      // 父目录的计数包含所有下级用例，点击父目录即可看到完整子树。
      node.count += 1;
      if (item.runnable) node.verified += 1;
      if (item.candidates.length > 0) node.candidates += 1;
    }
  }
  const serialize = (node) => [...node.children.values()]
    .sort((left, right) => left.name.localeCompare(right.name, "zh-CN"))
    .map((child) => ({
      name: child.name, path: child.path, count: child.count,
      verified: child.verified, candidates: child.candidates,
      children: serialize(child),
    }));
  return serialize(root);
}

// 每层都检查链接；读取不会创建目录或更新人工状态。
async function at(workspace, ...parts) {
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    check(!(await fs.lstat(current)).isSymbolicLink(), "测试数据不能使用符号链接。");
  }
  return current;
}
async function optionalDirectory(workspace, ...parts) {
  try {
    const directory = await at(workspace, ...parts);
    check((await fs.stat(directory)).isDirectory(), "测试数据目录无效。");
    return directory;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}
async function boundedRead(file, limit) {
  const info = await fs.stat(file);
  check(info.isFile() && info.size <= limit, "测试资产文件无效或过大。");
  const data = await fs.readFile(file);
  check(data.length <= limit, "测试资产文件过大。");
  return data;
}
async function assetAt(workspace, caseId) {
  check(validId(caseId), "用例编号无效。");
  const bytes = await boundedRead(await at(workspace, "qa", "ui", "cases", caseId, "asset.json"), 512 * 1024);
  const asset = JSON.parse(bytes);
  if (asset.schema !== "qa-ui-asset/v1") return null;
  check(asset.schema === "qa-ui-asset/v1" && asset.caseId === caseId && Array.isArray(asset.revisions) && asset.revisions.length > 0, "用例版本索引无效。");
  const numbers = asset.revisions.map((entry) => entry.revision);
  check(numbers.every((number) => typeof number === "string" && /^\d{4}$/.test(number)) && new Set(numbers).size === numbers.length &&
    (asset.currentRevision === null || numbers.includes(asset.currentRevision)), "用例版本索引无效。");
  return { asset, assetHash: hash(bytes) };
}
async function metaAt(workspace, projectId, caseId, entry, script = false) {
  const parts = ["qa", "ui", "cases", caseId, "revisions", entry.revision];
  const bytes = await boundedRead(await at(workspace, ...parts, "case.json"), 512 * 1024);
  check(hash(bytes) === entry.hashes?.["case.json"], "用例说明已变更，请保留现场并核对版本。");
  const meta = JSON.parse(bytes);
  check(meta.schema === "qa-ui-case/v1" && meta.caseId === caseId && (meta.taskId === entry.taskId || meta.taskId === entry.baseTaskId) && meta.project?.id === projectId, "用例说明与项目或来源不匹配。");
  check(typeof meta.title === "string" && Array.isArray(meta.modulePath), "用例标题或模块无效。");
  if (script) {
    const source = await boundedRead(await at(workspace, ...parts, "case.spec.cjs"), 512 * 1024);
    check(hash(source) === entry.hashes?.["case.spec.cjs"], "用例脚本已变更，请保留现场并核对版本。");
  }
  return meta;
}

async function withUiLock(workspace, operation) {
  const file = path.join(workspace, "qa", "ui", ".workflow.lock");
  let lock;
  try {
    lock = await fs.open(file, "wx", 0o600);
  } catch (error) {
    if (error.code === "EEXIST") throw new Error("该工作区已有 UI 任务或上次任务未收尾；请稍后重试。");
    throw error;
  }
  try {
    return await operation();
  } finally {
    await lock.close();
    await fs.unlink(file).catch(() => {});
  }
}

async function recentResults(workspace, projectId) {
  const results = new Map();
  const directory = await optionalDirectory(workspace, "qa", "ui", "runs");
  if (!directory) return results;
  const summaries = [];
  for (const item of await fs.readdir(directory, { withFileTypes: true })) {
    if (!item.isDirectory() || !validId(item.name)) continue;
    let summary;
    try {
      summary = JSON.parse(await boundedRead(await at(directory, item.name, "summary.json"), 1024 * 1024));
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (summary.schema !== "qa-report/v1" || summary.workflow !== "browser-use-playwright" || summary.purpose !== "regression" ||
      summary.project?.id !== projectId || summary.workspace !== workspace || summary.runId !== item.name) continue;
    summaries.push(summary);
  }
  summaries.sort((a, b) => (Date.parse(b.finishedAt) || 0) - (Date.parse(a.finishedAt) || 0) || b.runId.localeCompare(a.runId));
  for (const summary of summaries) {
    for (const [caseId, revision] of Object.entries(summary.revisions ?? {})) {
      if (!validId(caseId) || !/^\d{4}$/.test(revision)) continue;
      const key = `${caseId}/${revision}`;
      if (results.has(key)) continue;
      const file = path.join(workspace, "qa", "ui", "cases", caseId, "revisions", revision, "case.spec.cjs");
      const tests = (summary.tests ?? []).filter((test) => typeof test.file === "string" && path.resolve(workspace, "qa", "ui", "cases", test.file) === file);
      results.set(key, { runId: summary.runId, revision, status: tests.length === 1 ? tests[0].status : summary.status === "cancelled" ? "cancelled" : "unknown", finishedAt: summary.finishedAt });
    }
  }
  return results;
}

function createTestDataService(projectStore) {
  async function workspaceFor(projectId) {
    check(typeof projectId === "string" && projectId.trim(), "请选择项目环境。");
    const project = (await projectStore.list()).find((item) => item.id === projectId);
    check(project, "未找到该项目环境，请重新读取。");
    return fs.realpath(project.workspaceDir);
  }

  async function list(projectId, options = {}) {
    check(options && typeof options === "object" && !Array.isArray(options), "列表参数无效。");
    const { page = 1, query = "", folder: folderOption = "" } = options;
    check(Number.isSafeInteger(page) && page > 0 && typeof query === "string" && query.length <= 200, "分页或筛选参数无效。");
    const folder = parseFolder(folderOption);
    const workspace = await workspaceFor(projectId);
    const caseRoot = await optionalDirectory(workspace, "qa", "ui", "cases");
    const cases = [];
    if (caseRoot) {
      for (const item of await fs.readdir(caseRoot, { withFileTypes: true })) {
        if (!item.isDirectory() || !validId(item.name)) continue;
        let indexed;
        try { indexed = await assetAt(workspace, item.name); }
        catch (error) { if (error.code === "ENOENT") continue; throw error; }
        if (!indexed) continue;
        const { asset, assetHash } = indexed;
        const entry = asset.revisions.find((entry) => entry.revision === asset.currentRevision) ?? asset.revisions.at(-1);
        const meta = await metaAt(workspace, projectId, item.name, entry);
        const folderPath = storedFolder(asset) ?? folderPathOf(meta);
        cases.push({ caseId: item.name, title: meta.title, modulePath: meta.modulePath, folderPath, role: meta.role,
          currentRevision: asset.currentRevision, displayRevision: entry.revision,
          candidates: asset.revisions.filter((entry) => !entry.validatedRunId && (!asset.currentRevision || entry.revision > asset.currentRevision)).map((entry) => entry.revision),
          assetHash, runnable: Boolean(asset.currentRevision && entry.validatedRunId) });
      }
    }
    // 目录统计与树基于完整用例集，分页和搜索只作用于当前选择后的列表。
    const folders = folderTree(cases);
    const folderCases = folder.length > 0 ? cases.filter((item) => inFolder(item.folderPath, folder)) : cases;
    const needle = query.trim().toLocaleLowerCase();
    const filtered = needle
      ? folderCases.filter((item) => `${item.caseId} ${item.title} ${item.folderPath.join(" / ")} ${item.folderPath.join("/")} ${item.role}`.toLocaleLowerCase().includes(needle))
      : folderCases;
    filtered.sort((a, b) => a.folderPath.join("/").localeCompare(b.folderPath.join("/"), "zh-CN") || a.title.localeCompare(b.title, "zh-CN") || a.caseId.localeCompare(b.caseId));
    const pages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
    const selectedPage = Math.min(page, pages);
    const selected = filtered.slice((selectedPage - 1) * PAGE_SIZE, selectedPage * PAGE_SIZE);
    const results = selected.length ? await recentResults(workspace, projectId) : new Map();
    for (const item of selected) item.lastResult = item.currentRevision ? results.get(`${item.caseId}/${item.currentRevision}`) ?? null : null;

    const dataRoot = await optionalDirectory(workspace, "qa", "data");
    const items = [];
    async function walk(directory, prefix = "") {
      for (const entry of (await fs.readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.name.startsWith(".") || entry.isSymbolicLink() || relative === "ui/cases") continue;
        const file = await at(directory, entry.name);
        if (entry.isDirectory()) await walk(file, relative);
        else if (entry.isFile()) {
          const info = await fs.stat(file);
          items.push({ path: relative, name: entry.name, size: info.size, modifiedAt: info.mtimeMs });
        }
        if (items.length > 500) return;
      }
    }
    if (dataRoot) await walk(dataRoot);
    return { available: Boolean(dataRoot || caseRoot), items: items.slice(0, 500), truncated: items.length > 500,
      catalog: { cases: selected, total: filtered.length, allTotal: cases.length, page: selectedPage, pageSize: PAGE_SIZE, pages,
        folder, folders, verified: filtered.filter((item) => item.runnable).length,
        candidates: filtered.filter((item) => item.candidates.length > 0).length } };
  }

  async function getCase(projectId, caseId, revision) {
    check(typeof revision === "string" && /^\d{4}$/.test(revision), "用例版本无效。");
    const workspace = await workspaceFor(projectId);
    const indexed = await assetAt(workspace, caseId);
    check(indexed, "仅支持新版 UI 用例。");
    const { asset, assetHash } = indexed;
    const entry = asset.revisions.find((entry) => entry.revision === revision);
    check(entry, "未登记该用例版本，请刷新。");
    const meta = await metaAt(workspace, projectId, caseId, entry, true);
    return { caseId, revision, assetHash, currentRevision: asset.currentRevision,
      folder: storedFolder(asset) ?? folderPathOf(meta),
      revisions: asset.revisions.map(({ revision, taskId, validatedRunId, validationRunId, baseRevision, parentRunId, patchSummary }) =>
        ({ revision, taskId, validatedRunId, validationRunId, baseRevision, parentRunId, patchSummary })), meta };
  }

  async function moveCase(projectId, caseId, folder, assetHash) {
    check(validId(caseId), "用例编号无效。");
    check(typeof assetHash === "string" && /^[a-f0-9]{64}$/.test(assetHash), "用例版本校验值无效。");
    const workspace = await workspaceFor(projectId);
    await at(workspace, "qa", "ui");
    return withUiLock(workspace, async () => {
      const indexed = await assetAt(workspace, caseId);
      check(indexed, "仅支持新版 UI 用例。");
      check(indexed.assetHash === assetHash, "用例版本已变化，请刷新后重新设置目录。");
      const entry = indexed.asset.revisions.find((entry) => entry.revision === indexed.asset.currentRevision) ?? indexed.asset.revisions.at(-1);
      await metaAt(workspace, projectId, caseId, entry);
      const parts = parseFolder(Array.isArray(folder) ? folder.join("/") : folder ?? "");
      const asset = indexed.asset;
      if (parts.length > 0) asset.folder = parts;
      else delete asset.folder;
      const bytes = Buffer.from(JSON.stringify(asset, null, 2) + "\n");
      const file = path.join(workspace, "qa", "ui", "cases", caseId, "asset.json");
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
        await fs.rename(temporary, file);
      } catch (error) {
        await fs.rm(temporary, { force: true }).catch(() => {});
        throw error;
      }
      return { caseId, folder: parts, assetHash: hash(bytes) };
    });
  }

  async function removeCase(projectId, caseId, assetHash) {
    const workspace = await workspaceFor(projectId);
    const { removeUiCase } = await import("../capabilities/ui-testing/workflow.mjs");
    return removeUiCase(workspace, { projectId, caseId, assetHash });
  }

  async function remove(projectId, relativePath) {
    check(typeof relativePath === "string" && relativePath && !relativePath.includes("\0"), "测试数据路径无效。");
    const normalized = relativePath.replaceAll("\\", "/");
    const parts = normalized.split("/");
    check(!path.posix.isAbsolute(normalized) && !path.win32.isAbsolute(normalized) && parts.every((part) => part && part !== "." && part !== ".." && !part.startsWith(".")), "测试数据路径无效。");
    check(!(parts[0] === "ui" && parts[1] === "cases"), "旧 UI 用例不由此面板管理。");
    const workspace = await workspaceFor(projectId);
    const file = await at(workspace, "qa", "data", ...parts);
    check((await fs.stat(file)).isFile(), "只能删除测试数据文件。");
    await fs.unlink(file);
    return { path: normalized };
  }
  return { list, getCase, moveCase, removeCase, remove };
}

module.exports = { createTestDataService };
