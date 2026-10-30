import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { readWorkspaceSource } from "../workspace/read-workspace-source.mjs";

const MAX_OUTPUT_BYTES = 16 * 1024;

export function createReadLinesTool(workspaceDir) {
  return defineTool({
    name: "read_workspace_lines",
    label: "按行读取文件",
    description:
      "分段读取最大 1 MiB 的 UTF-8 文件。startLine 从 1 开始，" +
      "lineCount 为 1 到 200。返回行号及 nextLine；" +
      "nextLine 为 null 表示已到文件末尾。" +
      "仅用于阅读，不扩大草稿保存限制。",

    parameters: Type.Object({
      path: Type.String({
        minLength: 1,
        description: "文件相对路径",
      }),
      startLine: Type.Integer({
        minimum: 1,
        description: "起始行，从 1 开始",
      }),
      lineCount: Type.Integer({
        minimum: 1,
        maximum: 200,
        description: "最多返回多少行",
      }),
    }),

    async execute(_toolCallId, params, signal) {
      const { startLine, lineCount } = params;

      // 直接调用工具时，也检查行参数。
      if (
        !Number.isInteger(startLine) ||
        startLine < 1 ||
        !Number.isInteger(lineCount) ||
        lineCount < 1 ||
        lineCount > 200
      ) {
        throw new Error(
          "startLine 必须是正整数，lineCount 必须是 1 到 200 的整数。",
        );
      }

      // 与搜索共用源文本读取；分页与输出上限仍由本工具负责。
      const { path: relativePath, text: source } = await readWorkspaceSource(
        workspaceDir,
        params.path,
        signal,
      );

      const allLines = source
        ? source.split(/\r\n|\n|\r/)
        : [];

      // 文件末尾的换行符不额外算作一行。
      if (allLines.at(-1) === "") {
        allLines.pop();
      }

      if (startLine > Math.max(1, allLines.length)) {
        throw new Error(
          `起始行超过文件范围，文件共 ${allLines.length} 行。`,
        );
      }

      const lines = [];
      let bytes = 0;
      let index = startLine - 1;

      while (
        index < allLines.length &&
        lines.length < lineCount
      ) {
        signal?.throwIfAborted();

        const size = Buffer.byteLength(allLines[index], "utf8") + 1;

        if (bytes + size > MAX_OUTPUT_BYTES) {
          if (!lines.length) {
            throw new Error("该行超过 16 KiB，无法按完整行返回。");
          }

          break;
        }

        // 行号单独返回，不混入文件原文。
        lines.push({
          line: index + 1,
          text: allLines[index],
        });

        bytes += size;
        index += 1;
      }

      const result = {
        path: relativePath,
        totalLines: allLines.length,
        lines,
        nextLine: index < allLines.length ? index + 1 : null,
      };

      return {
        content: [
          { type: "text", text: JSON.stringify(result) },
        ],
        details: result,
      };
    },
  });
}