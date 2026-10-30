async function applyDefaultEdit(workspaceDir, proposal) {
  const { applyWorkspaceEdit } =
    await import("../workspace/apply-workspace-edit.mjs");

  return applyWorkspaceEdit(workspaceDir, proposal);
}

async function applyDefaultCreate(workspaceDir, proposal) {
  const { applyWorkspaceCreate } =
    await import("../workspace/apply-workspace-create.mjs");

  return applyWorkspaceCreate(workspaceDir, proposal);
}

function createProposalApplyService(
  workspaceDir,
  chatService,
  sessionService,
  applyEdit = applyDefaultEdit,
  applyCreate = applyDefaultCreate,
) {
  async function apply(id) {
    const proposal = await chatService.getProposal(id);

    if (!["edit-proposal", "create-proposal"].includes(proposal.kind)) {
      throw new Error("不支持保存该草稿类型。");
    }

    // 先落盘进行中状态；失败时不进入文件写入。
    chatService.beginProposalApply(proposal.sessionId, proposal.id);

    let result;

    try {
      result = proposal.kind === "create-proposal"
        ? await applyCreate(workspaceDir, proposal)
        : await applyEdit(workspaceDir, proposal);
    } catch (error) {
      try {
        chatService.cancelProposalApply(proposal.sessionId, proposal.id);
      } catch (stateError) {
        throw new Error(
          `${error.message}；草稿状态恢复失败：` +
            `${stateError.message}。请检查文件并重新生成草稿。`,
        );
      }

      throw error;
    }

    // 从这里开始文件已保存，后续错误只作为附加警告返回。
    const warnings = [];

    try {
      chatService.markProposalWritten(proposal.sessionId, proposal.id);
    } catch (error) {
      warnings.push(`草稿状态未确认落盘：${error.message}`);
    }

    let contextRecorded = false;

    try {
      await sessionService.recordWorkspaceEdit({
        ...proposal,
        // 记录保存模块实际采用的相对路径。
        path: result.path,
      });
      contextRecorded = true;
    } catch (error) {
      warnings.push(`会话记录未确认成功：${error.message}`);
    }

    return {
      id: proposal.id,
      ...result,
      contextRecorded,
      ...(warnings.length
        ? {
            // 底层清理警告与状态、会话警告需要同时保留。
            warning: [
              result.warning,
              `文件已保存；${warnings.join("；")}。` +
                "请检查文件，后续修改前重新读取。",
            ].filter(Boolean).join("\n"),
          }
        : {}),
    };
  }

  return { apply };
}

module.exports = { createProposalApplyService };