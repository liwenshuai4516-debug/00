import path from "node:path";
import { readdir } from "node:fs/promises";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import { isExcluded, resolveWorkspacePath } from "../workspace/path-policy.mjs";
import { readWorkspaceSource } from "../workspace/read-workspace-source.mjs";

const MAX_ENTRIES = 500;
const MAX_MATCHES = 30;

export function createSearchTextTool(workspaceDir) {
  return defineTool({
    name: "search_workspace_text",
    label: "搜索项目文本",
    description:
      "递归搜索工作目录中单文件最大 1 MiB 的 UTF-8 文本，区分大小写，使用普通字符串匹配。返回相对路径、从 1 开始的行号和文本片段。不跟随符号链接。",

    parameters: Type.Object({
      path: Type.String({
        description: "搜索起始目录，相对路径，例如 . 或 src",
      }),
      query: Type.String({
        minLength: 1,
        maxLength: 200,
        description: "要查找的原始字符串，不是正则表达式",
      }),
    }),

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      if (!params.query.trim()) {
        throw new Error("搜索内容不能为空。");
      }

      // 在遍历开始前检查用户指定的起始目录。
      const start = await resolveWorkspacePath(workspaceDir, params.path);
      const matches = [];
      const skipped = [];
      let skippedCount = 0;
      let visitedEntries = 0;
      let searchedFiles = 0;
      let truncated = false;

      async function visit(relativeDir) {
        const directory = await resolveWorkspacePath(workspaceDir, relativeDir);
        const entries = await readdir(directory.target, {
          withFileTypes: true,
        });

        // 固定遍历顺序，使结果和测试更容易复现。
        entries.sort((a, b) => a.name.localeCompare(b.name));

        for (const entry of entries) {
          signal?.throwIfAborted();

          if (visitedEntries >= MAX_ENTRIES) {
            truncated = true;
            return;
          }

          visitedEntries += 1;

          if (isExcluded(entry.name) || entry.isSymbolicLink()) {
            continue;
          }

          const filePath = path.join(relativeDir, entry.name);

          if (entry.isDirectory()) {
            await visit(filePath);
            if (truncated) return;
            continue;
          }

          if (!entry.isFile()) continue;

          let file;

          try {
            // 内部读取源文本，只将匹配片段交给模型。
            file = await readWorkspaceSource(workspaceDir, filePath, signal);
          } catch (error) {
            // 取消必须向上传播；普通文件读取失败则记录后继续。
            signal?.throwIfAborted();
            skippedCount += 1;

            if (skipped.length < 10) {
              skipped.push({ path: filePath, reason: error.message });
            }

            continue;
          }

          searchedFiles += 1;
          const lines = file.text.split(/\r\n|\n|\r/);

          for (let index = 0; index < lines.length; index += 1) {
            const column = lines[index].indexOf(params.query);
            if (column === -1) continue;

            // 返回关键词附近的片段，避免输出整条超长行。
            const previewStart = Math.max(0, column - 60);

            matches.push({
              path: file.path,
              line: index + 1,
              preview: lines[index].slice(previewStart, previewStart + 240),
            });

            if (matches.length >= MAX_MATCHES) {
              truncated = true;
              return;
            }
          }
        }
      }

      await visit(start.relativePath);

      const result = {
        path: start.relativePath,
        query: params.query,
        matches,
        searchedFiles,
        skippedCount,
        skipped,
        truncated,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}
