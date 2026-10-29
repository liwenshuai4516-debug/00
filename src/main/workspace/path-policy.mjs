import path from "node:path";
import { realpath } from "node:fs/promises";

const excludedNames = new Set(["node_modules", "sessions"]);

// 目录浏览和文件读取使用相同的排除规则。
export function isExcluded(name) {
  return name.startsWith(".") || excludedNames.has(name);
}

export async function resolveWorkspacePath(workspaceDir, relativePath) {
  if (path.isAbsolute(relativePath)) {
    throw new Error("请使用相对于工作目录的路径。");
  }

  const root = await realpath(workspaceDir);

  function checkPath(target) {
    const relative = path.relative(root, target);

    if (
      relative === ".." ||
      relative.startsWith(`..${path.sep}`) ||
      path.isAbsolute(relative)
    ) {
      throw new Error("不能访问工作目录之外的位置。");
    }

    if (relative.split(path.sep).some(isExcluded)) {
      throw new Error("该路径不对 Agent 开放。");
    }
  }

  // 同时检查原始路径和符号链接解析后的真实路径。
  const candidate = path.resolve(root, relativePath);
  checkPath(candidate);

  const target = await realpath(candidate);
  checkPath(target);

  return {
    target,
    relativePath: path.relative(root, target) || ".",
  };
}