import { open } from "node:fs/promises";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { resolveWorkspacePath } from "../workspace/path-policy.mjs";

// 限制单次读取大小，避免大文件占满模型上下文。
const MAX_BYTES = 32 * 1024;

export function createReadTextFileTool(workspaceDir) {
  return defineTool({
    name: "read_workspace_text_file",
    label: "读取文本文件",
    description:
      "读取工作目录内的 UTF-8 文本文件，最大 32 KiB。path 必须使用相对路径。",
    parameters: Type.Object({
      path: Type.String({ description: "文件相对路径，例如 src/main/main.js" }),
    }),

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      const resolved = await resolveWorkspacePath(workspaceDir, params.path);
      const file = await open(resolved.target, "r");

      try {
        const info = await file.stat();

        if (!info.isFile()) {
          throw new Error("请选择普通文件，不能读取目录。");
        }

        if (info.size > MAX_BYTES) {
          throw new Error("文件超过 32 KiB，暂不支持读取。");
        }

        // 多读一个字节，检测读取期间文件变大而超过上限的情况。
        const buffer = Buffer.alloc(MAX_BYTES + 1);
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

        if (total > MAX_BYTES) {
          throw new Error("文件超过 32 KiB，暂不支持读取。");
        }

        const bytes = buffer.subarray(0, total);
        let text;

        // 拒绝常见二进制内容和无效 UTF-8，避免输出乱码。
        try {
          if (bytes.includes(0)) throw new Error("包含空字节");
          // 保留 UTF-8 BOM，使后续保存不会意外删除文件的编码标记。
          // ignoreBOM: true 表示不特殊处理 BOM，将它保留在文本中。
          text = new TextDecoder("utf-8", {
            fatal: true,
            ignoreBOM: true,
          }).decode(bytes);
        } catch {
          throw new Error("文件不是支持的 UTF-8 文本。");
        }

        signal?.throwIfAborted();

        const result = {
          path: resolved.relativePath,
          text,
        };

        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: result,
        };
      } finally {
        // 成功、失败或取消都必须关闭文件。
        await file.close();
      }
    },
  });
}
