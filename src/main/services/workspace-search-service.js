const { readdir, realpath } = require("node:fs/promises");
const path = require("node:path");

// 引用搜索覆盖工作目录内的普通文件与目录；限制扫描量，避免大仓库卡住输入。
const MAX_SCAN = 2000;
const MAX_RESULTS = 50;
const MAX_DEPTH = 10;
const MAX_QUERY = 120;
const SKIP_NAMES = new Set(["node_modules", ".git", "sessions", ".DS_Store"]);
const DENIED_FILE = /^\.env(\.|$)/i;

function rank(item, query) {
  if (query === "") return 0;
  const name = item.name.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (name.includes(query)) return 2;
  return 3;
}

function createWorkspaceSearch(getWorkspaceDir) {
  return async function search(input) {
    const query = typeof input === "string" ? input.trim().toLowerCase() : "";
    if (query.length > MAX_QUERY) throw new Error("搜索词过长。");

    const workspaceDir = await getWorkspaceDir();
    if (!workspaceDir) throw new Error("当前会话还没有工作目录。");

    let root;
    try {
      root = await realpath(workspaceDir);
    } catch {
      throw new Error("工作目录不可读。");
    }

    const matches = [];
    let scanned = 0;
    let truncated = false;
    // 广度优先：根目录文件优先出现，深度受限，符号链接不展开。
    const queue = [{ dir: root, depth: 0 }];
    while (queue.length > 0) {
      if (scanned >= MAX_SCAN) {
        truncated = true;
        break;
      }
      const { dir, depth } = queue.shift();
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (scanned >= MAX_SCAN) {
          truncated = true;
          break;
        }
        const name = entry.name;
        if (SKIP_NAMES.has(name) || DENIED_FILE.test(name) || entry.isSymbolicLink()) continue;
        const full = path.join(dir, name);
        scanned += 1;
        const relative = path.relative(root, full).split(path.sep).join("/");
        const matched = query === "" || relative.toLowerCase().includes(query);
        if (entry.isDirectory()) {
          if (matched) matches.push({ path: relative, name, type: "dir" });
          if (depth + 1 <= MAX_DEPTH) queue.push({ dir: full, depth: depth + 1 });
          continue;
        }
        if (!entry.isFile() || !matched) continue;
        matches.push({ path: relative, name, type: "file" });
      }
    }

    matches.sort((left, right) => {
      const rankDiff = rank(left, query) - rank(right, query);
      if (rankDiff !== 0) return rankDiff;
      const lengthDiff = left.path.length - right.path.length;
      if (lengthDiff !== 0) return lengthDiff;
      return left.path.localeCompare(right.path, "zh-CN");
    });

    return {
      items: matches.slice(0, MAX_RESULTS),
      truncated: truncated || matches.length > MAX_RESULTS,
    };
  };
}

module.exports = { createWorkspaceSearch, MAX_SEARCH_RESULTS: MAX_RESULTS };
