import { open } from "node:fs/promises";
import { resolveWorkspacePath } from "./path-policy.mjs";

const MAX_FILE_BYTES = 1024 * 1024;

// 仅供主进程内部使用：读取源文本，不直接输出到模型上下文。
export async function readWorkspaceSource(workspaceDir, filePath, signal) {
  signal?.throwIfAborted();

  const resolved = await resolveWorkspacePath(workspaceDir, filePath);
  const file = await open(resolved.target, "r");

  try {
    const info = await file.stat();

    if (!info.isFile()) {
      throw new Error("请选择普通文件，不能读取目录。");
    }

    if (info.size > MAX_FILE_BYTES) {
      throw new Error("文件超过 1 MiB，暂不支持读取。");
    }

    // 多读一个字节，检测读取过程中增长到超限的文件。
    const buffer = Buffer.alloc(MAX_FILE_BYTES + 1);
    let total = 0;

    while (total < buffer.length) {
      signal?.throwIfAborted();

      const { bytesRead } = await file.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );

      if (bytesRead === 0) break;
      total += bytesRead;
    }

    if (total > MAX_FILE_BYTES) {
      throw new Error("文件超过 1 MiB，暂不支持读取。");
    }

    const bytes = buffer.subarray(0, total);
    let text;

    try {
      if (bytes.includes(0)) throw new Error("包含空字节");

      // 严格验证 UTF-8，并保留原文中的 BOM。
      text = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
    } catch {
      throw new Error("文件不是支持的 UTF-8 文本。");
    }

    signal?.throwIfAborted();

    return {
      path: resolved.relativePath,
      text,
    };
  } finally {
    // 成功、失败和取消都要释放文件句柄。
    await file.close();
  }
}