const path = require("node:path");
const { readdir, readFile, realpath, stat, lstat, unlink } = require("node:fs/promises");

const DATA_SEGMENTS = ["qa", "data"];
const MAX_FILES = 500;
const MAX_CASE_ASSETS = 200;
const MAX_ASSET_BYTES = 512 * 1024;
const CASE_TYPES = new Set(["functional", "permission", "boundary", "exception", "regression"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const DATA_POLICIES = new Set(["read-only", "write-unique", "write-disposable", "no-write"]);
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function emptyCatalog() {
  return {
    modules: [],
    legacy: [],
    truncated: false,
    totals: { modules: 0, cases: 0, assertions: 0, legacy: 0 },
  };
}

function text(value, max) {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function safeId(value) {
  const id = text(value, 200);
  return /^[\p{L}\p{N}_-]+$/u.test(id) ? id : "";
}

function legacyEntry(item) {
  return {
    path: item.path,
    name: item.name,
    size: item.size,
    modifiedAt: item.modifiedAt,
  };
}

function isOutside(relative) {
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

// 测试数据只落在项目工作目录的 qa/data；页面只提交相对路径与项目编号。
function createTestDataService(projectStore) {
  async function resolveRoot(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目环境。");
    }
    const project = (await projectStore.list()).find(
      (item) => item.id === projectId,
    );
    if (!project) {
      throw new Error("未找到该项目环境，请重新读取。");
    }

    const root = path.join(project.workspaceDir, ...DATA_SEGMENTS);
    let resolved;
    try {
      resolved = await realpath(root);
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
    const info = await stat(resolved);
    if (!info.isDirectory()) {
      throw new Error("测试数据目录无效。");
    }
    return resolved;
  }

  async function list(projectId) {
    const root = await resolveRoot(projectId);
    if (root === null) {
      return { available: false, truncated: false, items: [], catalog: emptyCatalog() };
    }

    const items = [];
    const assets = [];
    async function walk(directory, prefix) {
      if (items.length >= MAX_FILES) return;
      const entries = await readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (items.length >= MAX_FILES) break;
        if (entry.name.startsWith(".")) continue;
        const absolute = path.join(directory, entry.name);
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
          await walk(absolute, relative);
          continue;
        }
        if (!entry.isFile()) continue;

        try {
          const info = await stat(absolute);
          const item = {
            path: relative,
            name: entry.name,
            category: relative.includes("/") ? relative.split("/")[0] : "",
            size: info.size,
            modifiedAt: info.mtimeMs,
          };
          items.push(item);
          if (
            relative.startsWith("ui/cases/") &&
            relative.endsWith(".asset.json") &&
            relative.split("/").length === 3
          ) {
            assets.push(item);
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
    }

    await walk(root, "");
    items.sort(
      (first, second) =>
        (first.category || "\uffff").localeCompare(
          second.category || "\uffff",
        ) || second.modifiedAt - first.modifiedAt,
    );

    const catalog = await buildCatalog(root, assets);
    return {
      available: true,
      truncated: items.length >= MAX_FILES,
      items,
      catalog,
    };
  }

  // qa-ui-case 元数据是分类索引：按页面归为模块，模块内列出用例与断言；旧资产单独计数。
  async function buildCatalog(root, assets) {
    const modules = new Map();
    const legacy = [];
    for (const item of assets.slice(0, MAX_CASE_ASSETS)) {
      if (item.size > MAX_ASSET_BYTES) {
        legacy.push(legacyEntry(item));
        continue;
      }
      let metadata;
      try {
        metadata = JSON.parse(await readFile(path.join(root, ...item.path.split("/")), "utf8"));
      } catch {
        legacy.push(legacyEntry(item));
        continue;
      }
      const caseMeta = metadata?.caseMeta;
      if (
        caseMeta?.schema !== "qa-ui-case/v1" ||
        !Array.isArray(caseMeta.cases) ||
        caseMeta.cases.length === 0
      ) {
        legacy.push(legacyEntry(item));
        continue;
      }

      const page = text(caseMeta.page, 300) || "未标注页面";
      const tags = Array.isArray(caseMeta.tags)
        ? caseMeta.tags.map((tag) => text(tag, 40)).filter(Boolean).slice(0, 8)
        : [];
      if (!modules.has(page)) {
        modules.set(page, {
          key: page,
          page,
          title: tags[0] || page,
          role: text(caseMeta.role, 80),
          dataPolicy: DATA_POLICIES.has(caseMeta.dataPolicy) ? caseMeta.dataPolicy : "read-only",
          tags: new Set(),
          cases: [],
        });
      }
      const module = modules.get(page);
      for (const tag of tags) module.tags.add(tag);
      if (!module.role) module.role = text(caseMeta.role, 80);

      const caseId = safeId(caseMeta.caseId);
      const recordedAt = text(metadata.recordedAt, 40);
      for (const entry of caseMeta.cases.slice(0, 100)) {
        const name = text(entry?.name, 300);
        if (!name) continue;
        const assertions = (Array.isArray(entry.assertions) ? entry.assertions : [])
          .slice(0, 50)
          .map((assertion, index) => ({
            id: text(assertion?.id, 20) || `A${index + 1}`,
            kind: assertion?.kind === "guard" ? "guard" : "business",
            text: text(assertion?.text, 500),
            source: text(assertion?.source, 500),
          }))
          .filter((assertion) => assertion.text);
        module.cases.push({
          name,
          type: CASE_TYPES.has(entry.type) ? entry.type : "functional",
          priority: PRIORITIES.has(entry.priority) ? entry.priority : "P2",
          assertions,
          caseId,
          assetPath: item.path,
          specPath: caseId ? `ui/cases/${caseId}.spec.cjs` : "",
          documentPath: caseId ? `ui/cases/${caseId}.md` : "",
          recordedAt,
          modifiedAt: item.modifiedAt,
        });
      }
    }

    const result = [...modules.values()]
      .filter((module) => module.cases.length > 0)
      .map((module) => ({
        ...module,
        tags: [...module.tags],
        cases: module.cases.sort(
          (first, second) =>
            PRIORITY_ORDER[first.priority] - PRIORITY_ORDER[second.priority] ||
            first.name.localeCompare(second.name, "zh-CN"),
        ),
      }))
      .sort((first, second) => first.title.localeCompare(second.title, "zh-CN"));
    const cases = result.reduce((total, module) => total + module.cases.length, 0);
    return {
      modules: result,
      legacy,
      truncated: assets.length > MAX_CASE_ASSETS,
      totals: {
        modules: result.length,
        cases,
        assertions: result.reduce(
          (total, module) =>
            total + module.cases.reduce((sum, item) => sum + item.assertions.length, 0),
          0,
        ),
        legacy: legacy.length,
      },
    };
  }

  async function remove(projectId, relativePath) {
    if (typeof relativePath !== "string" || !relativePath) {
      throw new Error("请选择要删除的测试数据。");
    }
    if (relativePath.includes("\0")) {
      throw new Error("测试数据路径无效。");
    }
    const normalized = relativePath.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(normalized) ||
      segments.some((segment) => segment === "" || segment === "." || segment === "..")
    ) {
      throw new Error("测试数据路径无效。");
    }

    const root = await resolveRoot(projectId);
    if (root === null) {
      throw new Error("测试数据目录不存在。");
    }
    const target = path.join(root, ...segments);
    const relative = path.relative(root, target);
    if (!relative || isOutside(relative)) {
      throw new Error("测试数据路径超出 qa/data。");
    }

    let linkInfo;
    try {
      linkInfo = await lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") {
        throw new Error("测试数据已不存在，请刷新。");
      }
      throw error;
    }
    if (linkInfo.isSymbolicLink()) {
      throw new Error("不能删除符号链接。");
    }
    if (!linkInfo.isFile()) {
      throw new Error("只能删除测试数据文件。");
    }

    const resolved = await realpath(target);
    const resolvedRelative = path.relative(root, resolved);
    if (!resolvedRelative || isOutside(resolvedRelative)) {
      throw new Error("测试数据路径超出 qa/data。");
    }

    await unlink(resolved);
    return { path: normalized };
  }

  return { list, remove };
}

module.exports = { createTestDataService };
