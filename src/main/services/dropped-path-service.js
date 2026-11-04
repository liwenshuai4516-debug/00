const { realpath, stat } = require("node:fs/promises");
const path = require("node:path");

// 拖入只转换为可引用的普通文件：工作目录内用相对路径，其余保留绝对路径。
const MAX_FILES = 20;

function createDroppedPathResolver(getWorkspaceDir) {
  return async function describe(input) {
    if (!Array.isArray(input)) throw new Error("拖入内容无效。");
    if (input.length > MAX_FILES) throw new Error(`一次最多引用 ${MAX_FILES} 个文件。`);
    if (input.length === 0) return [];

    const workspaceDir = await getWorkspaceDir();
    let root = null;
    if (workspaceDir) {
      try {
        root = await realpath(workspaceDir);
      } catch {
        root = null;
      }
    }

    const items = [];
    for (const value of input) {
      if (typeof value !== "string" || value === "" || value.length > 1024) continue;
      let target;
      try {
        target = await realpath(value);
      } catch {
        continue;
      }
      let info;
      try {
        info = await stat(target);
      } catch {
        continue;
      }
      if (!info.isFile()) continue;

      let display = target;
      if (root !== null) {
        const relative = path.relative(root, target);
        const inside = relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
        if (inside) display = relative.split(path.sep).join("/");
      }
      items.push({ path: display });
    }
    return items;
  };
}

module.exports = { createDroppedPathResolver, MAX_DROPPED_FILES: MAX_FILES };
