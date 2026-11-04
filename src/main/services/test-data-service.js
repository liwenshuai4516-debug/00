const path = require("node:path");
const { readdir, realpath, stat, lstat, unlink } = require("node:fs/promises");

const DATA_SEGMENTS = ["qa", "data"];
const MAX_FILES = 500;

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
      return { available: false, truncated: false, items: [] };
    }

    const items = [];
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
          items.push({
            path: relative,
            name: entry.name,
            category: relative.includes("/") ? relative.split("/")[0] : "",
            size: info.size,
            modifiedAt: info.mtimeMs,
          });
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

    return {
      available: true,
      truncated: items.length >= MAX_FILES,
      items,
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
