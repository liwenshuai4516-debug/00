import path from "node:path";
import { lstat, stat } from "node:fs/promises";
import {
  isExcluded,
  resolveWorkspacePath,
} from "./path-policy.mjs";

// 只解析新文件目标，不创建目录或文件。
export async function resolveNewFilePath(workspaceDir, relativePath) {
  if (
    typeof relativePath !== "string" ||
    !relativePath.trim()
  ) {
    throw new Error("请提供新文件的相对路径。");
  }

  if (path.isAbsolute(relativePath)) {
    throw new Error("请使用相对于工作目录的路径。");
  }

  const name = path.basename(relativePath);

  if (
    name === "." ||
    name === ".." ||
    relativePath.endsWith(path.sep)
  ) {
    throw new Error("请提供具体的新文件名。");
  }

  if (isExcluded(name)) {
    throw new Error("该文件名不对 Agent 开放。");
  }

  // 目标尚不存在，对父目录复用现有路径和符号链接检查。
  const parent = await resolveWorkspacePath(
    workspaceDir,
    path.dirname(relativePath),
  );

  if (!(await stat(parent.target)).isDirectory()) {
    throw new Error("新文件的父路径必须是已有目录。");
  }

  const target = path.join(parent.target, name);

  try {
    // lstat 能识别失效的符号链接，不能把它当成空闲文件名。
    await lstat(target);
  } catch (error) {
    // 只有目标不存在时才允许继续，其他错误原样抛出。
    if (error.code !== "ENOENT") throw error;

    return {
      target,
      relativePath: parent.relativePath === "."
        ? name
        : path.join(parent.relativePath, name),
    };
  }

  throw new Error("目标路径已经存在，不能新建文件。");
}