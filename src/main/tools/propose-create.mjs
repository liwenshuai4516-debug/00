import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { resolveNewFilePath } from "../workspace/resolve-new-file-path.mjs";

const MAX_BYTES = 32 * 1024;

export function createProposeCreateTool(workspaceDir) {
  return defineTool({
    name: "propose_workspace_create",
    label: "生成新建文件草稿",
    description:
      "在已有目录中生成新建 UTF-8 文本文件的草稿，不写入文件，不覆盖已有路径。内容最大 32 KiB。",

    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        maxLength: 1024,
        description: "新文件相对路径，父目录必须已经存在",
      }),
      content: Type.String({
        maxLength: MAX_BYTES,
        description: "新文件的完整内容，允许为空字符串",
      }),
    }),

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      const { content } = params;

      // 直接调用时同样检查，不能只依赖参数 Schema。
      if (
        typeof content !== "string" ||
        content.includes("\0")
      ) {
        throw new Error("新文件内容必须是文本，不能包含空字节。");
      }

      // 中文等字符可能占多个字节，按 UTF-8 实际大小限制。
      const bytes = Buffer.byteLength(content, "utf8");

      if (bytes > MAX_BYTES) {
        throw new Error("新文件内容超过 32 KiB，暂不支持。");
      }

      const resolved = await resolveNewFilePath(
        workspaceDir,
        params.path,
      );

      signal?.throwIfAborted();

      const proposal = {
        kind: "create-proposal",
        path: resolved.relativePath,
        content,
        written: false,
      };

      return {
        content: [
          {
            type: "text",
            text: [
              "状态：新建文件草稿，尚未写入文件",
              `文件：${proposal.path}`,
              `内容大小：${bytes} 字节`,
            ].join("\n"),
          },
        ],

        // 完整内容保存在结构化草稿中，不重复回显到工具说明。
        details: proposal,
      };
    },
  });
}