import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  parseSessionEntries,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const BINDING_TYPE = "desktop-workspace-binding";

// 返回不能继续使用的原因；空字符串表示绑定检查通过。
// 先只读检查，再交给 SDK 打开，避免被拒绝的旧文件先被迁移。
async function getSessionBindingError(sessionPath, workspaceRoot) {
  if (!(await stat(sessionPath)).isFile()) {
    return "会话路径不是普通文件。";
  }

  const entries = parseSessionEntries(
    await readFile(sessionPath, "utf8"),
  );

  const header = entries[0];

  if (
    header?.type !== "session" ||
    typeof header.id !== "string"
  ) {
    return "会话文件头无效，无法继续。";
  }

  const bindings = entries.filter(
    (entry) =>
      entry.type === "custom" &&
      entry.customType === BINDING_TYPE,
  );

  if (bindings.length === 0) {
    return "旧会话缺少工作目录绑定，请点击“新建对话”后继续。旧记录仍保留。";
  }

  if (
    bindings.length !== 1 ||
    bindings[0].data?.version !== 1
  ) {
    return "会话工作目录绑定记录无效。";
  }

  if (bindings[0].data.workspaceRoot !== workspaceRoot) {
    return "该会话属于其他工作目录，请恢复原目录配置或新建对话。";
  }

  // 文件头与应用绑定必须同时指向当前真实目录。
  if (header.cwd !== workspaceRoot) {
    return "会话目录与绑定记录不一致，无法继续。";
  }

  return "";
}

export async function createWorkspaceSession({
  sessionDir,
  workspaceDir,
  resume = false,
  sessionPath,
}) {
  if (!workspaceDir || !path.isAbsolute(workspaceDir)) {
    throw new Error(
      "请在 .env 中将 AGENT_WORKSPACE_DIR 配置为绝对路径。",
    );
  }

  // 符号链接别名统一转换为真实目录，再核对会话归属。
  const workspaceRoot = await realpath(workspaceDir);

  if (!(await stat(workspaceRoot)).isDirectory()) {
    throw new Error("AGENT_WORKSPACE_DIR 必须指向目录。");
  }

  let selectedPath = sessionPath;

  if (selectedPath) {
    // 用户明确选择了会话，检查失败就报告原因。
    const error = await getSessionBindingError(
      selectedPath,
      workspaceRoot,
    );

    if (error) throw new Error(error);
  } else if (resume) {
    // SDK 按当前工作目录列出会话；仍需核对应用自己的绑定记录。
    // 列表按最近活动排序，逐个寻找合法记录。
    const sessions = await SessionManager.list(
      workspaceRoot,
      sessionDir,
    );

    for (const session of sessions) {
      const error = await getSessionBindingError(
        session.path,
        workspaceRoot,
      );

      if (!error) {
        selectedPath = session.path;
        break;
      }
    }
  }

  if (selectedPath) {
    return {
      workspaceRoot,
      sessionManager: SessionManager.open(
        selectedPath,
        sessionDir,
      ),
    };
  }

  // 没有匹配记录时新建，不认领或修改无绑定旧记录。
  const manager = SessionManager.create(
    workspaceRoot,
    sessionDir,
  );

  manager.appendCustomEntry(BINDING_TYPE, {
    version: 1,
    workspaceRoot,
  });

  return {
    workspaceRoot,
    sessionManager: manager,
  };
}
