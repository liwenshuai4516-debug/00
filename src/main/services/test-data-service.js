const path = require("node:path");
const { readdir, readFile, writeFile, realpath, stat, lstat, unlink } = require("node:fs/promises");

const DATA_SEGMENTS = ["qa", "data"];
const MAX_FILES = 500;
const MAX_CASE_ASSETS = 200;
const MAX_ASSET_BYTES = 512 * 1024;
const MAX_RUNS = 50;
const MAX_SUMMARY_BYTES = 1024 * 1024;
const MAX_MODULE_DEPTH = 6;
const MAX_MODULE_TITLE = 60;
const CASE_TYPES = new Set(["functional", "permission", "boundary", "exception", "regression"]);
const PRIORITIES = new Set(["P0", "P1", "P2", "P3"]);
const DATA_POLICIES = new Set(["read-only", "write-unique", "write-disposable", "no-write"]);
const PRIORITY_ORDER = { P0: 0, P1: 1, P2: 2, P3: 3 };

function emptyCatalog() {
  return {
    modules: [],
    legacy: [],
    truncated: false,
    totals: { modules: 0, submodules: 0, cases: 0, assertions: 0, legacy: 0 },
    lastRun: null,
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

// 目录层级只取显式 modulePath；旧资产缺少该字段时由 buildCatalog 按页面兼容。
function readModulePath(caseMeta) {
  if (!Array.isArray(caseMeta?.modulePath)) return [];
  return caseMeta.modulePath
    .map((segment) => text(segment, MAX_MODULE_TITLE))
    .filter(Boolean)
    .slice(0, MAX_MODULE_DEPTH);
}

function finalizeModule(node) {
  node.children.sort(
    (first, second) =>
      first.title.localeCompare(second.title, "zh-CN") ||
      first.key.localeCompare(second.key),
  );
  node.cases.sort(
    (first, second) =>
      PRIORITY_ORDER[first.priority] - PRIORITY_ORDER[second.priority] ||
      first.name.localeCompare(second.name, "zh-CN"),
  );
  for (const child of node.children) finalizeModule(child);

  node.caseCount =
    node.cases.length +
    node.children.reduce((total, child) => total + child.caseCount, 0);
  node.assertionCount =
    node.cases.reduce((total, item) => total + item.assertions.length, 0) +
    node.children.reduce((total, child) => total + child.assertionCount, 0);
  node.pages = [...node.pages].sort((first, second) => first.localeCompare(second, "zh-CN"));
  node.roles = [...node.roles].sort((first, second) => first.localeCompare(second, "zh-CN"));
  node.tags = [...node.tags];
  node.policies = [...node.policies];
  node.page = node.pages.length === 1 ? node.pages[0] : "";
  node.role = node.roles.length === 1 ? node.roles[0] : "";
  if (node.policies.length === 1) node.dataPolicy = node.policies[0];
  else if (node.policies.length > 1) node.dataPolicy = "mixed";
  else node.dataPolicy = "";
}

function pruneEmptyModules(node) {
  node.children = node.children.filter((child) => {
    pruneEmptyModules(child);
    return child.caseCount > 0;
  });
}

function countModules(modules) {
  let total = 0;
  const stack = [...modules];
  while (stack.length > 0) {
    const node = stack.pop();
    total += 1;
    stack.push(...node.children);
  }
  return total;
}

function isOutside(relative) {
  return (
    relative === ".." ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  );
}

function summaryCaseId(file) {
  const base = String(file).split(/[\\/]/).pop() ?? "";
  return base.replace(/\.spec\.cjs$/i, "");
}

// 回放结果按脚本 + 用例名匹配；同一用例取最近一次批次的结果。
async function readRunResults(workspace) {
  const directory = path.join(workspace, "qa/ui/runs");
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === "ENOENT") return { latest: null, byCase: new Map() };
    throw error;
  }

  const summaries = [];
  for (const entry of entries.slice(0, 200)) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const file = path.join(directory, entry.name, "summary.json");
    let info;
    try {
      info = await stat(file);
    } catch (error) {
      if (error.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.size > MAX_SUMMARY_BYTES) continue;
    let summary;
    try {
      summary = JSON.parse(await readFile(file, "utf8"));
    } catch {
      continue;
    }
    if (!summary || typeof summary.runId !== "string" || !Array.isArray(summary.tests)) continue;
    summaries.push({ ...summary, modifiedAt: info.mtimeMs });
  }

  summaries.sort((first, second) => {
    const firstTime = Date.parse(first.finishedAt ?? "") || first.modifiedAt || 0;
    const secondTime = Date.parse(second.finishedAt ?? "") || second.modifiedAt || 0;
    return secondTime - firstTime;
  });
  if (summaries.length > MAX_RUNS) summaries.length = MAX_RUNS;

  const byCase = new Map();
  for (const summary of summaries) {
    for (const test of summary.tests) {
      if (!test || typeof test.file !== "string" || typeof test.title !== "string") continue;
      const key = `${summaryCaseId(test.file)}::${test.title.split(" > ").pop()}`;
      if (byCase.has(key)) continue;
      byCase.set(key, {
        status: typeof test.status === "string" ? test.status : "unknown",
        durationMs: Number.isFinite(test.durationMs) ? test.durationMs : null,
        finishedAt: typeof summary.finishedAt === "string" ? summary.finishedAt : null,
        runId: summary.runId,
      });
    }
  }

  const latest = summaries[0]
    ? {
      runId: summaries[0].runId,
      status: typeof summaries[0].status === "string" ? summaries[0].status : "unknown",
      startedAt: typeof summaries[0].startedAt === "string" ? summaries[0].startedAt : null,
      finishedAt: typeof summaries[0].finishedAt === "string" ? summaries[0].finishedAt : null,
      total: summaries[0].tests.length,
      passed: summaries[0].tests.filter((test) => test?.status === "passed").length,
      failed: summaries[0].tests.filter((test) => ["failed", "timedOut"].includes(test?.status)).length,
      skipped: summaries[0].tests.filter((test) => test?.status === "skipped").length,
      cancelled: summaries[0].tests.filter((test) => test?.status === "cancelled").length,
    }
    : null;
  return { latest, byCase };
}

function normalizeCaseAssertions(assertions) {
  if (!Array.isArray(assertions) || assertions.length === 0) throw new Error("至少需要一条断言。");
  if (assertions.length > 50) throw new Error("断言不能超过 50 条。");
  const result = assertions.map((assertion, index) => {
    const content = text(assertion?.text, 500);
    const source = text(assertion?.source, 500);
    if (!content) throw new Error(`第 ${index + 1} 条断言内容不能为空。`);
    if (!source) throw new Error(`第 ${index + 1} 条断言来源不能为空。`);
    return {
      id: text(assertion?.id, 20) || `A${index + 1}`,
      kind: assertion?.kind === "guard" ? "guard" : "business",
      text: content,
      source,
    };
  });
  if (!result.some((assertion) => assertion.kind === "business")) throw new Error("至少需要一条业务断言。");
  return result;
}

function normalizeCaseSteps(steps) {
  if (!Array.isArray(steps) || steps.length === 0) throw new Error("至少需要一个执行步骤。");
  if (steps.length > 50) throw new Error("执行步骤不能超过 50 条。");
  return steps.map((step, index) => {
    const content = text(step, 500);
    if (!content) throw new Error(`第 ${index + 1} 个执行步骤不能为空。`);
    return content;
  });
}

function replaceAssertionTableRow(document, caseName, assertions) {
  const summary = assertions
    .map((assertion) => `${assertion.id} ${assertion.kind === "guard" ? "前置" : "业务"}：${assertion.text}${assertion.source ? `（${assertion.source}）` : ""}`)
    .join("；");
  const lines = document.split("\n");
  let inSection = false;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim() === "## 用例与断言") { inSection = true; continue; }
    if (!inSection) continue;
    if (line.trim().startsWith("## ")) break;
    if (!line.startsWith("|")) continue;
    const cells = line.split("|");
    if (cells.length >= 6 && cells[1].trim() === caseName) {
      cells[4] = ` ${summary.replaceAll("|", "\\|")} `;
      lines[index] = cells.join("|");
      break;
    }
  }
  return lines.join("\n");
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
    return { root: resolved, workspace: project.workspaceDir };
  }

  async function list(projectId) {
    const resolved = await resolveRoot(projectId);
    if (resolved === null) {
      return { available: false, truncated: false, items: [], catalog: emptyCatalog() };
    }
    const { root, workspace } = resolved;

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
    await applyRunResults(catalog, workspace);
    return {
      available: true,
      truncated: items.length >= MAX_FILES,
      items,
      catalog,
    };
  }

  function applyRunResultsToModules(modules, byCase) {
    for (const module of modules) {
      for (const item of module.cases) {
        item.lastResult = byCase.get(`${item.caseId}::${item.name}`) ?? null;
      }
      applyRunResultsToModules(module.children, byCase);
    }
  }

  async function applyRunResults(catalog, workspace) {
    const { latest, byCase } = await readRunResults(workspace);
    applyRunResultsToModules(catalog.modules, byCase);
    catalog.lastRun = latest;
  }

  // qa-ui-case 元数据是分类索引：modulePath 对应实际项目目录层级；旧资产按页面归组。
  async function buildCatalog(root, assets) {
    const nodes = new Map();
    const roots = [];
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
      const role = text(caseMeta.role, 80);
      const tags = Array.isArray(caseMeta.tags)
        ? caseMeta.tags.map((tag) => text(tag, 40)).filter(Boolean).slice(0, 8)
        : [];
      const dataPolicy = DATA_POLICIES.has(caseMeta.dataPolicy) ? caseMeta.dataPolicy : "read-only";
      const modulePath = readModulePath(caseMeta);
      const explicitPath = modulePath.length > 0;
      const title = explicitPath ? modulePath[modulePath.length - 1] : tags[0] || page;
      const idPath = explicitPath ? modulePath : [page];

      let module = null;
      for (let index = 0; index < idPath.length; index += 1) {
        const prefix = idPath.slice(0, index + 1);
        const key = explicitPath ? prefix.join("\u001f") : `page:${page}`;
        let node = nodes.get(key);
        if (!node) {
          node = {
            key,
            path: explicitPath ? prefix : [title],
            title: explicitPath ? prefix[prefix.length - 1] : title,
            depth: explicitPath ? index : 0,
            cases: [],
            children: [],
            pages: new Set(),
            roles: new Set(),
            tags: new Set(),
            policies: new Set(),
          };
          nodes.set(key, node);
          if (module) module.children.push(node);
          else roots.push(node);
        }
        module = node;
      }

      for (const tag of tags) module.tags.add(tag);
      module.pages.add(page);
      if (role) module.roles.add(role);
      module.policies.add(dataPolicy);

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
        const steps = (Array.isArray(entry.steps) ? entry.steps : [])
          .slice(0, 50)
          .map((step) => text(step, 500))
          .filter(Boolean);
        module.cases.push({
          name,
          type: CASE_TYPES.has(entry.type) ? entry.type : "functional",
          priority: PRIORITIES.has(entry.priority) ? entry.priority : "P2",
          steps,
          assertions,
          caseId,
          assetPath: item.path,
          specPath: caseId ? `ui/cases/${caseId}.spec.cjs` : "",
          documentPath: caseId ? `ui/cases/${caseId}.md` : "",
          page,
          role,
          recordedAt,
          modifiedAt: item.modifiedAt,
        });
      }
    }

    for (const node of roots) finalizeModule(node);
    const modules = roots.filter((node) => {
      pruneEmptyModules(node);
      return node.caseCount > 0;
    });
    modules.sort(
      (first, second) =>
        first.title.localeCompare(second.title, "zh-CN") ||
        first.key.localeCompare(second.key),
    );
    const cases = modules.reduce((total, module) => total + module.caseCount, 0);
    const assertions = modules.reduce((total, module) => total + module.assertionCount, 0);
    const totalModules = countModules(modules);
    return {
      modules,
      legacy,
      truncated: assets.length > MAX_CASE_ASSETS,
      totals: {
        modules: modules.length,
        submodules: Math.max(0, totalModules - modules.length),
        cases,
        assertions,
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

    const resolvedRoot = await resolveRoot(projectId);
    if (resolvedRoot === null) {
      throw new Error("测试数据目录不存在。");
    }
    const { root } = resolvedRoot;
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

  async function updateCase(projectId, assetPath, caseName, changes) {
    if (typeof assetPath !== "string" || !assetPath.trim()) throw new Error("请选择要编辑的用例资产。");
    if (typeof caseName !== "string" || !caseName.trim()) throw new Error("请选择要编辑的用例。");
    const normalized = assetPath.replaceAll("\\", "/");
    const segments = normalized.split("/");
    if (
      path.posix.isAbsolute(normalized) ||
      path.win32.isAbsolute(normalized) ||
      segments.length !== 3 ||
      segments[0] !== "ui" ||
      segments[1] !== "cases" ||
      !segments[2].endsWith(".asset.json") ||
      segments.some((segment) => !segment || segment === "." || segment === "..")
    ) {
      throw new Error("只能编辑 qa/data/ui/cases 下的用例资产。");
    }
    const nextSteps = changes.steps === undefined ? null : normalizeCaseSteps(changes.steps);
    const nextAssertions = changes.assertions === undefined
      ? null
      : normalizeCaseAssertions(changes.assertions);
    if (nextSteps === null && nextAssertions === null) throw new Error("没有要保存的用例内容。");
    const resolved = await resolveRoot(projectId);
    if (resolved === null) throw new Error("测试数据目录不存在。");
    const { root } = resolved;
    const target = path.join(root, ...segments);
    const relative = path.relative(root, target);
    if (!relative || isOutside(relative)) throw new Error("用例资产路径超出 qa/data。");

    let link;
    try {
      link = await lstat(target);
    } catch (error) {
      if (error.code === "ENOENT") throw new Error("用例资产已不存在，请刷新。");
      throw error;
    }
    if (link.isSymbolicLink()) throw new Error("不能编辑符号链接。");
    if (!link.isFile()) throw new Error("只能编辑用例资产文件。");
    const real = await realpath(target);
    if (isOutside(path.relative(root, real))) throw new Error("用例资产路径超出 qa/data。");

    let metadata;
    try {
      metadata = JSON.parse(await readFile(real, "utf8"));
    } catch {
      throw new Error("用例资产不是有效 JSON，无法编辑用例。");
    }
    const caseMeta = metadata?.caseMeta;
    if (caseMeta?.schema !== "qa-ui-case/v1" || !Array.isArray(caseMeta.cases)) {
      throw new Error("用例资产缺少 qa-ui-case/v1 元数据，无法编辑用例。");
    }
    const targetCase = caseMeta.cases.find((item) => item.name === caseName);
    if (!targetCase) throw new Error("未找到该用例，请刷新后重试。");
    if (nextSteps !== null) targetCase.steps = nextSteps;
    if (nextAssertions !== null) {
      targetCase.assertions = nextAssertions;
      caseMeta.assertionCount = caseMeta.cases.reduce(
        (total, item) => total + (Array.isArray(item.assertions) ? item.assertions.length : 0),
        0,
      );
    }

    // 先更新人读文档，再写资产索引；文档缺失时只更新资产。
    const documentPath = real.replace(/\.asset\.json$/, ".md");
    try {
      let document = await readFile(documentPath, "utf8");
      const block = document.match(/```json qa-ui-case[ \t]*\r?\n([\s\S]*?)\r?\n```/);
      if (block) {
        const documentMeta = JSON.parse(block[1]);
        const documentCase = documentMeta?.cases?.find((item) => item.name === caseName);
        if (documentCase) {
          if (nextSteps !== null) documentCase.steps = nextSteps;
          if (nextAssertions !== null) documentCase.assertions = nextAssertions;
          document = document.replace(block[0], "```json qa-ui-case\n" + JSON.stringify(documentMeta, null, 2) + "\n```");
        }
      }
      if (nextAssertions !== null) document = replaceAssertionTableRow(document, caseName, nextAssertions);
      await writeFile(documentPath, document);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }

    await writeFile(real, JSON.stringify(metadata, null, 2) + "\n");
    return {
      path: normalized,
      caseName,
      ...(nextSteps === null ? {} : { steps: nextSteps }),
      ...(nextAssertions === null ? {} : { assertions: nextAssertions }),
    };
  }

  function updateAssertions(projectId, assetPath, caseName, assertions) {
    return updateCase(projectId, assetPath, caseName, { assertions });
  }

  function updateSteps(projectId, assetPath, caseName, steps) {
    return updateCase(projectId, assetPath, caseName, { steps });
  }

  return { list, remove, updateAssertions, updateSteps };
}

module.exports = { createTestDataService };
