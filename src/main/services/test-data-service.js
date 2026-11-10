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

// 手动用例与 Agent 生成用例共用 qa-ui-asset/v1 索引，但保持 currentRevision 为空、
// 使用占位 spec，避免被当成可执行正式用例；执行前仍需由 Agent 生成并验证脚本。
const MANUAL_SPEC = `const { test } = require("@playwright/test");

// 手动用例尚未生成自动化脚本；发布前必须由 Agent 生成并验证可执行 spec。
test("手动用例待生成自动化脚本", async () => {
  test.skip(true, "手动用例尚未生成自动化脚本");
});
`;

function normalizeManualInput(input) {
  check(input && typeof input === "object" && !Array.isArray(input), "用例参数无效。");
  const title = typeof input.title === "string" ? input.title.trim() : "";
  check(title && title.length <= 120, "用例标题不能为空且不能超过 120 个字符。");
  const folder = parseFolder(input.folder ?? "");
  const role = typeof input.role === "string" && input.role.trim() ? input.role.trim().slice(0, 80) : "未指定角色";
  const priority = ["P0", "P1", "P2"].includes(input.priority) ? input.priority : "P2";
  const description = typeof input.description === "string" ? input.description.trim().slice(0, 2000) : "";
  const expected = typeof input.expected === "string" ? input.expected.trim().slice(0, 2000) : "";
  check(input.steps === undefined || Array.isArray(input.steps), "用例步骤参数无效。");
  const steps = (input.steps ?? []).map((step) => typeof step === "string" ? step.trim() : "")
    .filter(Boolean).slice(0, 30);
  check(steps.every((step) => step.length <= 300), "单个用例步骤不能超过 300 个字符。");
  return { title, folder, role, priority, description, steps, expected };
}

function manualMeta({ caseId, taskId, project, fields }) {
  const expected = fields.expected
    ? [{ id: "E1", text: fields.expected, source: { kind: "user", reference: "用例面板手动创建" } }]
    : [];
  return {
    schema: "qa-ui-case/v1",
    caseId,
    taskId,
    project: { id: project.id, name: project.name },
    title: fields.title,
    modulePath: fields.folder.length > 0 ? fields.folder : ["未分类"],
    targetUrl: typeof project.address === "string" ? project.address : "",
    role: fields.role,
    initialState: "手动创建，未记录初态",
    dataStrategy: "read-only",
    cleanup: "none",
    expected,
    steps: fields.steps.map((text, index) => ({ stepId: `manual-${String(index + 1).padStart(2, "0")}`, text })),
    assertions: fields.expected ? [{ kind: "business", text: fields.expected, expectedId: "E1" }] : [],
    description: fields.description,
    priority: fields.priority,
    origin: "manual",
  };
}

function manualAsset({ caseId, taskId, folder, metaBytes, specBytes }) {
  const asset = {
    schema: "qa-ui-asset/v1",
    caseId,
    currentRevision: null,
    origin: "manual",
    revisions: [{
      revision: "0001",
      taskId,
      hashes: {
        "case.json": hash(metaBytes),
        "case.spec.cjs": hash(specBytes),
      },
      validatedRunId: null,
      origin: "manual",
    }],
  };
  if (folder.length > 0) asset.folder = folder;
  return Buffer.from(JSON.stringify(asset, null, 2) + "\n");
}

async function writeAtomic(file, bytes) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
    await fs.rename(temporary, file);
  } catch (error) {
    await fs.rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function ensureDirectory(workspace, ...parts) {
  let current = workspace;
  for (const part of parts) {
    current = path.join(current, part);
    try { await fs.mkdir(current, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const info = await fs.lstat(current);
    check(info.isDirectory() && !info.isSymbolicLink(), "测试数据目录无效。");
  }
  return current;
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
  const file = await at(workspace, "qa", "ui", "cases", caseId, "asset.json");
  const info = await fs.stat(file);
  const bytes = await boundedRead(file, 512 * 1024);
  const asset = JSON.parse(bytes);
  if (asset.schema !== "qa-ui-asset/v1") return null;
  check(asset.schema === "qa-ui-asset/v1" && asset.caseId === caseId && Array.isArray(asset.revisions) && asset.revisions.length > 0, "用例版本索引无效。");
  const numbers = asset.revisions.map((entry) => entry.revision);
  check(numbers.every((number) => typeof number === "string" && /^\d{4}$/.test(number)) && new Set(numbers).size === numbers.length &&
    (asset.currentRevision === null || numbers.includes(asset.currentRevision)), "用例版本索引无效。");
  return { asset, assetHash: hash(bytes), updatedAt: info.mtimeMs };
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
  async function projectFor(projectId) {
    check(typeof projectId === "string" && projectId.trim(), "请选择项目环境。");
    const project = (await projectStore.list()).find((item) => item.id === projectId);
    check(project, "未找到该项目环境，请重新读取。");
    return project;
  }

  async function workspaceFor(projectId) {
    const project = await projectFor(projectId);
    return fs.realpath(project.workspaceDir);
  }

  async function list(projectId, options = {}) {
    check(options && typeof options === "object" && !Array.isArray(options), "列表参数无效。");
    const { page = 1, query = "", folder: folderOption = "", filter = "all", sort = "folder" } = options;
    check(Number.isSafeInteger(page) && page > 0 && typeof query === "string" && query.length <= 200, "分页或筛选参数无效。");
    check(["all", "verified", "candidate", "manual"].includes(filter), "用例状态筛选参数无效。");
    check(["updated", "folder", "title"].includes(sort), "用例排序参数无效。");
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
        const { asset, assetHash, updatedAt } = indexed;
        const entry = asset.revisions.find((entry) => entry.revision === asset.currentRevision) ?? asset.revisions.at(-1);
        const meta = await metaAt(workspace, projectId, item.name, entry);
        const folderPath = storedFolder(asset) ?? folderPathOf(meta);
        const manual = asset.origin === "manual" || entry.origin === "manual" || meta.origin === "manual";
        cases.push({ caseId: item.name, title: meta.title, modulePath: meta.modulePath, folderPath, role: meta.role,
          description: typeof meta.description === "string" ? meta.description : "",
          priority: ["P0", "P1", "P2"].includes(meta.priority) ? meta.priority : null,
          manual, origin: manual ? "manual" : "generated", updatedAt,
          currentRevision: asset.currentRevision, displayRevision: entry.revision,
          candidates: manual ? [] : asset.revisions.filter((entry) => !entry.validatedRunId && (!asset.currentRevision || entry.revision > asset.currentRevision)).map((entry) => entry.revision),
          assetHash, runnable: !manual && Boolean(asset.currentRevision && entry.validatedRunId) });
      }
    }
    // 目录统计与树基于完整用例集，分页和搜索只作用于当前选择后的列表。
    const folders = folderTree(cases);
    const folderCases = folder.length > 0 ? cases.filter((item) => inFolder(item.folderPath, folder)) : cases;
    const needle = query.trim().toLocaleLowerCase();
    const matched = needle
      ? folderCases.filter((item) => `${item.caseId} ${item.title} ${item.folderPath.join(" / ")} ${item.folderPath.join("/")} ${item.role} ${item.description}`.toLocaleLowerCase().includes(needle))
      : folderCases;
    const filterCounts = {
      all: matched.length,
      verified: matched.filter((item) => item.runnable).length,
      candidate: matched.filter((item) => item.candidates.length > 0).length,
      manual: matched.filter((item) => item.manual).length,
    };
    const filtered = matched.filter((item) => {
      if (filter === "verified") return item.runnable;
      if (filter === "candidate") return item.candidates.length > 0;
      if (filter === "manual") return item.manual;
      return true;
    });
    filtered.sort((a, b) => {
      if (sort === "updated") return (b.updatedAt - a.updatedAt) || a.folderPath.join("/").localeCompare(b.folderPath.join("/"), "zh-CN") || a.title.localeCompare(b.title, "zh-CN");
      if (sort === "title") return a.title.localeCompare(b.title, "zh-CN") || a.caseId.localeCompare(b.caseId);
      return a.folderPath.join("/").localeCompare(b.folderPath.join("/"), "zh-CN") || a.title.localeCompare(b.title, "zh-CN") || a.caseId.localeCompare(b.caseId);
    });
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
        folder, folders, filter, sort, filterCounts,
        verified: matched.filter((item) => item.runnable).length,
        candidates: matched.filter((item) => item.candidates.length > 0).length,
        manual: matched.filter((item) => item.manual).length } };
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
    const manual = asset.origin === "manual" || entry.origin === "manual" || meta.origin === "manual";
    return { caseId, revision, assetHash, currentRevision: asset.currentRevision,
      origin: manual ? "manual" : "generated", manual,
      folder: storedFolder(asset) ?? folderPathOf(meta),
      revisions: asset.revisions.map(({ revision, taskId, validatedRunId, validationRunId, baseRevision, parentRunId, patchSummary, origin }) =>
        ({ revision, taskId, validatedRunId, validationRunId, baseRevision, parentRunId, patchSummary, origin })),
      meta };
  }

  async function createManualCase(projectId, input) {
    const project = await projectFor(projectId);
    const workspace = await fs.realpath(project.workspaceDir);
    const fields = normalizeManualInput(input);
    await ensureDirectory(workspace, "qa", "ui");
    return withUiLock(workspace, async () => {
      const caseId = `case-${randomUUID()}`;
      const taskId = `manual-${randomUUID()}`;
      const caseDir = await ensureDirectory(workspace, "qa", "ui", "cases", caseId);
      try {
        const revisionDir = await ensureDirectory(caseDir, "revisions", "0001");
        const metaBytes = Buffer.from(JSON.stringify(manualMeta({ caseId, taskId, project, fields }), null, 2) + "\n");
        const specBytes = Buffer.from(MANUAL_SPEC);
        await fs.writeFile(path.join(revisionDir, "case.json"), metaBytes, { flag: "wx", mode: 0o600 });
        await fs.writeFile(path.join(revisionDir, "case.spec.cjs"), specBytes, { flag: "wx", mode: 0o600 });
        const assetBytes = manualAsset({ caseId, taskId, folder: fields.folder, metaBytes, specBytes });
        await writeAtomic(path.join(caseDir, "asset.json"), assetBytes);
        return { caseId, revision: "0001", folder: fields.folder, assetHash: hash(assetBytes) };
      } catch (error) {
        await fs.rm(caseDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
  }

  async function updateManualCase(projectId, caseId, input, assetHash) {
    check(validId(caseId), "用例编号无效。");
    check(typeof assetHash === "string" && /^[a-f0-9]{64}$/.test(assetHash), "用例版本校验值无效。");
    const project = await projectFor(projectId);
    const workspace = await fs.realpath(project.workspaceDir);
    const fields = normalizeManualInput(input);
    await ensureDirectory(workspace, "qa", "ui");
    return withUiLock(workspace, async () => {
      const indexed = await assetAt(workspace, caseId);
      check(indexed, "仅支持新版 UI 用例。");
      check(indexed.assetHash === assetHash, "用例版本已变化，请刷新后重新编辑。");
      const { asset } = indexed;
      const latest = asset.revisions.at(-1);
      const meta = await metaAt(workspace, projectId, caseId, latest);
      const manual = asset.origin === "manual" || latest.origin === "manual" || meta.origin === "manual";
      check(manual, "只有手动用例可以通过面板编辑；Agent 用例请通过修复任务生成候选。");
      check(asset.currentRevision === null, "该用例已经有正式版本，请通过修复任务生成候选。");
      const numbers = asset.revisions.map((entry) => Number(entry.revision));
      const number = String(Math.max(0, ...numbers) + 1).padStart(4, "0");
      check(Number(number) <= 9999, "手动用例版本过多，请整理后再编辑。");
      const revisionDir = await ensureDirectory(workspace, "qa", "ui", "cases", caseId, "revisions", number);
      try {
        const nextMeta = manualMeta({ caseId, taskId: latest.taskId, project, fields });
        const metaBytes = Buffer.from(JSON.stringify(nextMeta, null, 2) + "\n");
        const specBytes = Buffer.from(MANUAL_SPEC);
        await fs.writeFile(path.join(revisionDir, "case.json"), metaBytes, { flag: "wx", mode: 0o600 });
        await fs.writeFile(path.join(revisionDir, "case.spec.cjs"), specBytes, { flag: "wx", mode: 0o600 });
        asset.revisions.push({
          revision: number,
          taskId: latest.taskId,
          hashes: { "case.json": hash(metaBytes), "case.spec.cjs": hash(specBytes) },
          validatedRunId: null,
          origin: "manual",
        });
        asset.origin = "manual";
        if (fields.folder.length > 0) asset.folder = fields.folder;
        else delete asset.folder;
        const assetBytes = Buffer.from(JSON.stringify(asset, null, 2) + "\n");
        await writeAtomic(path.join(workspace, "qa", "ui", "cases", caseId, "asset.json"), assetBytes);
        return { caseId, revision: number, folder: fields.folder, assetHash: hash(assetBytes) };
      } catch (error) {
        await fs.rm(revisionDir, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    });
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
  return { list, getCase, moveCase, removeCase, remove, createManualCase, updateManualCase };
}

module.exports = { createTestDataService };
