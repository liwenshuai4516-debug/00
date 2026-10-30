import { currentTimeTool } from "./current-time.mjs";
import { createListDirectoryTool } from "./list-directory.mjs";
import { createSearchTextTool } from "./search-text.mjs";
import { createReadTextFileTool } from "./read-text-file.mjs";
import { createProposeEditTool } from "./propose-edit.mjs";
import { createReadLinesTool } from "./read-lines.mjs";

// 集中声明应用向模型开放的工具。
export function createAgentTools(workspaceDir) {
  return [
    currentTimeTool,
    createListDirectoryTool(workspaceDir),
    createReadTextFileTool(workspaceDir),
    createSearchTextTool(workspaceDir),
    createProposeEditTool(workspaceDir),
    createReadLinesTool(workspaceDir),
  ];
}