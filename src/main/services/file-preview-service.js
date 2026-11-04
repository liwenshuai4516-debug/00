const { readFile, realpath, stat } = require("node:fs/promises");
const path = require("node:path");

// 页面预览只读取普通文本文件；路径由主进程解析并限制在当前会话工作目录内。
const MAX_PREVIEW_BYTES = 512 * 1024;
// 只在工作目录内提供预览，但 .env 这类凭据文件始终不返回页面。
const DENIED_FILE = /^\.env(\.|$)/i;

function relativeInside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative) || relative === ".." || relative.startsWith(`..${path.sep}`)) {
    return null;
  }
  return relative;
}

function createFilePreviewReader(getWorkspaceDir) {
  return async function readPreview(input) {
    if (typeof input !== "string" || input.trim() === "") throw new Error("缺少文件路径。");
    if (input.length > 1024) throw new Error("文件路径过长。");

    // Markdown 链接可能带行号或锚点；只按路径部分解析。
    let decoded;
    try {
      decoded = decodeURIComponent(input.split(/[?#]/)[0]);
    } catch {
      throw new Error("文件路径无法解码。");
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
    if (!relativeInside(root, candidate)) throw new Error("只能预览当前工作目录内的文件。");

    let target;
    try {
      target = await realpath(candidate);
    } catch {
      throw new Error("文件不存在或不可读。");
    }
    // 符号链接指向工作目录之外时同样拒绝。
    const relative = relativeInside(root, target);
    if (relative === null) throw new Error("只能预览当前工作目录内的文件。");
    if (relative.split(path.sep).some((name) => DENIED_FILE.test(name))) {
      throw new Error("该文件不提供预览。");
    }

    const info = await stat(target);
    if (!info.isFile()) throw new Error("只能预览普通文件。");
    if (info.size > MAX_PREVIEW_BYTES) {
      throw new Error(`文件超过 ${MAX_PREVIEW_BYTES / 1024} KiB，暂不支持预览。`);
    }

    const buffer = await readFile(target);
    if (buffer.includes(0)) throw new Error("二进制文件暂不支持预览。");

    return {
      // 页面只拿相对路径用于展示和再次请求，不接收真实绝对路径。
      path: relative.split(path.sep).join("/"),
      content: buffer.toString("utf8"),
      size: info.size,
    };
  };
}

module.exports = { createFilePreviewReader, MAX_PREVIEW_BYTES };
