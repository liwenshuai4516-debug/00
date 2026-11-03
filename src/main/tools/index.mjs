import { currentTimeTool } from "./current-time.mjs";
import { createListDirectoryTool } from "./list-directory.mjs";
import { createSearchTextTool } from "./search-text.mjs";
import { createReadTextFileTool } from "./read-text-file.mjs";
import { createProposeEditTool } from "./propose-edit.mjs";
import { createProposeCreateTool } from "./propose-create.mjs";
import { createReadLinesTool } from "./read-lines.mjs";

// 旧草稿工具的兼容入口，仅保留历史测试用途；当前 Pi 会话不注册此工具集。
export function createAgentTools(workspaceDir) {
  return [
    currentTimeTool,
    createListDirectoryTool(workspaceDir),
    createReadTextFileTool(workspaceDir),
    createSearchTextTool(workspaceDir),
    createProposeEditTool(workspaceDir),
    createProposeCreateTool(workspaceDir),
    createReadLinesTool(workspaceDir),
  ];
}
