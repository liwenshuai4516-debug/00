import { readdir } from "node:fs/promises";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import {
  isExcluded,
  resolveWorkspacePath,
} from "../workspace/path-policy.mjs";

export function createListDirectoryTool(workspaceDir) {
  return defineTool({
    name: "list_workspace_directory",
    label: "查看工作目录",
    description:
      "列出工作目录中的文件和子目录。path 使用相对路径，根目录填写 .；不返回文件内容。",
    parameters: Type.Object({
      path: Type.String({ description: "相对于工作目录的路径，例如 . 或 src" }),
    }),

    async execute(_toolCallId, params, signal) {
      signal?.throwIfAborted();

      const resolved = await resolveWorkspacePath(workspaceDir, params.path);
      const entries = await readdir(resolved.target, { withFileTypes: true });

      signal?.throwIfAborted();

      const visible = entries
        .filter((entry) => !isExcluded(entry.name))
        .sort((a, b) => a.name.localeCompare(b.name));

      const items = visible.slice(0, 200).map((entry) => ({
        name: entry.name,
        type: entry.isSymbolicLink()
          ? "link"
          : entry.isDirectory()
            ? "directory"
            : "file",
      }));

      const result = {
        path: resolved.relativePath,
        items,
        truncated: visible.length > 200,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(result) }],
        details: result,
      };
    },
  });
}