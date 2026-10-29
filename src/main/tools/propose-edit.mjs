import { createHash } from "node:crypto";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { createReadTextFileTool } from "./read-text-file.mjs";

export function createProposeEditTool(workspaceDir) {
  const reader = createReadTextFileTool(workspaceDir);

  return defineTool({
    name: "propose_workspace_edit",
    label: "生成修改草稿",
    description:
      "为已有文本文件生成一次精确替换草稿，不写入文件。应先读取文件，oldText 必须与原文完全一致且只出现一次。",

    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        maxLength: 1024,
        description: "文件相对路径",
      }),
      oldText: Type.String({
        minLength: 1,
        maxLength: 1000,
        description: "需要替换的原文，应包含足够上下文以唯一定位",
      }),
      newText: Type.String({
        maxLength: 1000,
        description: "替换后的文本；空字符串表示删除原文",
      }),
    }),

    async execute(toolCallId, params, signal) {
      signal?.throwIfAborted();

      const { oldText, newText } = params;

      // 除了参数 Schema，也检查直接调用时的关键约束。
      if (!oldText || oldText.length > 1000 || newText.length > 1000) {
        throw new Error("原文不能为空，原文和新文本分别不能超过 1000 个字符。");
      }

      if (oldText === newText) {
        throw new Error("替换前后内容相同，没有需要修改的内容。");
      }

      // 复用读取规则，排除隐藏文件、目录外路径和不支持的文件。
      const result = await reader.execute(
        toolCallId,
        { path: params.path },
        signal,
      );

      const source = result.details.text;
      const index = source.indexOf(oldText);

      if (index === -1) {
        throw new Error("文件中找不到原文，请重新读取文件后生成草稿。");
      }

      if (source.indexOf(oldText, index + 1) !== -1) {
        throw new Error("原文出现多次，请增加上下文以唯一定位。");
      }

      const updated =
        source.slice(0, index) +
        newText +
        source.slice(index + oldText.length);

      if (Buffer.byteLength(updated, "utf8") > 32 * 1024) {
        throw new Error("修改后的文本超过 32 KiB，暂不支持。");
      }

      signal?.throwIfAborted();

      const proposal = {
        kind: "edit-proposal",
        path: result.details.path,
        oldText,
        newText,
        // 记录本次读取文本的基线，供后续保存时检查内容是否变化。
        baseTextHash: createHash("sha256").update(source, "utf8").digest("hex"),
        written: false,
      };

      return {
        content: [
          {
            type: "text",
            text: [
              "状态：修改草稿，尚未写入文件",
              `文件：${proposal.path}`,
              "替换前：",
              oldText,
              "替换后：",
              newText || "（删除以上原文）",
            ].join("\n"),
          },
        ],
        details: proposal,
      };
    },
  });
}