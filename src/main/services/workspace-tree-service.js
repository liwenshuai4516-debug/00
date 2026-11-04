const { readdir, realpath, stat } = require("node:fs/promises");
const path = require("node:path");

// 文件树只列当前会话工作目录内的普通条目；单个目录最多返回 500 项。
const MAX_ENTRIES = 500;
// 工程目录与应用程序数据不进入浏览范围；.env 由文件预览统一拒绝。
const SKIP_NAMES = new Set(["node_modules", ".git", "sessions", ".DS_Store"]);
const DENIED_FILE = /^\.env(\.|$)/i;

// 返回工作目录内的相对路径；根目录本身返回空字符串，越界返回 null。
function inside(root, target) {
  const relative = path.relative(root, target);
  if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return relative;
}

function createWorkspaceTreeReader(getWorkspaceDir) {
  return async function listDirectory(input) {
    const requested = typeof input === "string" && input.trim() !== "" ? input : ".";
    if (requested.length > 1024) throw new Error("路径过长。");

    let decoded;
    try {
      decoded = decodeURIComponent(requested.split(/[?#]/)[0]);
    } catch {
      throw new Error("路径无法解码。");
    }

    const workspaceDir = await getWorkspaceDir();
    if (!workspaceDir) throw new Error("当前会话还没有工作目录。");

    let root;
    try {
      root = await realpath(workspaceDir);
    } catch {
      throw new Error("工作目录不可读。");
    }

    const candidate = path.resolve(root, decoded);
    if (inside(root, candidate) === null) throw new Error("只能浏览当前工作目录。");

    let target;
    try {
      target = await realpath(candidate);
    } catch {
      throw new Error("目录不存在或不可读。");
    }
    const relative = inside(root, target);
    if (relative === null) throw new Error("只能浏览当前工作目录。");

    const info = await stat(target);
    if (!info.isDirectory()) throw new Error("只能浏览目录。");

    const dirents = await readdir(target, { withFileTypes: true });
    const entries = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (entries.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const name = dirent.name;
      if (SKIP_NAMES.has(name) || DENIED_FILE.test(name)) continue;
      // 符号链接可能指向工作目录之外或形成环，文件树不展开。
      if (dirent.isSymbolicLink()) continue;
      if (!dirent.isDirectory() && !dirent.isFile()) continue;

      const child = path.join(target, name);
      const childRelative = path.relative(root, child);
      if (childRelative.split(path.sep).some((part) => DENIED_FILE.test(part))) continue;

      let size = 0;
      if (dirent.isFile()) {
        try {
          size = (await stat(child)).size;
        } catch {
          continue;
        }
      }
      entries.push({
        name,
        path: childRelative.split(path.sep).join("/"),
        type: dirent.isDirectory() ? "dir" : "file",
        size,
      });
    }

    // 目录在前，其余按名称排序；排序只在页面展示层生效。
    entries.sort((left, right) => {
      if (left.type !== right.type) return left.type === "dir" ? -1 : 1;
      return left.name.localeCompare(right.name, "zh-CN");
    });

    return {
      path: path.relative(root, target).split(path.sep).join("/"),
      entries,
      truncated,
    };
  };
}

module.exports = { createWorkspaceTreeReader, MAX_TREE_ENTRIES: MAX_ENTRIES };
