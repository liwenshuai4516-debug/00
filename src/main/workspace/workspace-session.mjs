import path from "node:path";
import { readFile, realpath, stat } from "node:fs/promises";
import {
  parseSessionEntries,
  SessionManager,
} from "@mariozechner/pi-coding-agent";

const BINDING_TYPE = "desktop-workspace-binding";

// 返回不能继续使用的原因；空字符串表示绑定检查通过。
// 先只读检查，再交给 SDK 打开，避免被拒绝的旧文件先被迁移。
async function getSessionBindingError(sessionPath, workspaceRoot, expectedSessionId) {
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

  if (expectedSessionId !== undefined && header.id !== expectedSessionId) {
    return "会话文件编号与恢复登记不一致。";
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
  recovery,
  archivedSessionIds = [],
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
  if (recovery !== undefined) {
    if (resume || sessionPath) {
      throw new Error("登记恢复不能同时指定历史路径或自动恢复。");
    }
    if (!recovery || typeof recovery.sessionId !== "string" || !recovery.sessionId) {
      throw new Error("恢复登记缺少原会话编号。");
    }
    if (recovery.workspaceDir !== workspaceRoot) {
      throw new Error("恢复登记不属于当前真实工作目录。");
    }

    // 真实历史优先；跨目录也查原编号，随后执行原有绑定检查。
    const matches = (await SessionManager.listAll(sessionDir)).filter(
      (session) => session.id === recovery.sessionId,
    );
    if (matches.length > 1) {
      throw new Error("发现多份相同编号的历史，无法确定恢复目标。");
    }
    selectedPath = matches[0]?.path;
    if (!selectedPath) {
      // 文件缺失本身不能证明为空；来源未知、历史丢失及待确认发送均拒绝重建。
      if (recovery.registration?.source !== "empty") {
        throw new Error("原会话没有可恢复历史，也没有可信的空会话登记。");
      }
      if (recovery.pendingSend != null) {
        throw new Error("该会话仍有待确认发送，不能重建为空会话。");
      }
      if (typeof recovery.draft?.text !== "string" || recovery.draft.text.length === 0) {
        throw new Error("该空会话没有待恢复的输入。");
      }
      const model = recovery.registration.model;
      if (typeof model?.provider !== "string" || !model.provider.trim() ||
          typeof model.modelId !== "string" || !model.modelId.trim()) {
        throw new Error("恢复登记缺少原模型选择。");
      }
    }
  }

  if (selectedPath) {
    // 用户明确选择了会话，检查失败就报告原因。
    const error = await getSessionBindingError(
      selectedPath,
      workspaceRoot,
      recovery?.sessionId,
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
      if (archivedSessionIds.includes(session.id)) continue;
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
      // 来源由通过绑定检查后的实际分支确定，不靠文件缺失推断。
      source: "history",
      sessionManager: SessionManager.open(
        selectedPath,
        sessionDir,
      ),
    };
  }

  // 普通新建使用新编号；可信空会话重建保留原编号，不伪造历史消息。
  const manager = SessionManager.create(
    workspaceRoot,
    sessionDir,
    recovery === undefined ? undefined : { id: recovery.sessionId },
  );

  manager.appendCustomEntry(BINDING_TYPE, {
    version: 1,
    workspaceRoot,
  });

  return {
    workspaceRoot,
    source: "empty",
    sessionManager: manager,
  };
}
