async function applyDefaultEdit(workspaceDir, proposal) {
  const { applyWorkspaceEdit } = await import(
    "../workspace/apply-workspace-edit.mjs"
  );

  return applyWorkspaceEdit(workspaceDir, proposal);
}

function createProposalApplyService(
  workspaceDir,
  chatService,
  sessionService,
  applyEdit = applyDefaultEdit,
) {
  async function apply(id) {
    const proposal = await chatService.getProposal(id);

    // 先落盘进行中状态；失败时不进入文件写入。
    chatService.beginProposalApply(
      proposal.sessionId,
      proposal.id,
    );

    let result;

    try {
      result = await applyEdit(workspaceDir, proposal);
    } catch (error) {
      try {
        chatService.cancelProposalApply(
          proposal.sessionId,
          proposal.id,
        );
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
      chatService.markProposalWritten(
        proposal.sessionId,
        proposal.id,
      );
    } catch (error) {
      warnings.push(`草稿状态未确认落盘：${error.message}`);
    }

    let contextRecorded = false;

    try {
      await sessionService.recordWorkspaceEdit(proposal);
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
            warning:
              `文件已保存；${warnings.join("；")}。` +
              "请检查文件，后续修改前重新读取。",
          }
        : {}),
    };
  }

  return { apply };
}

module.exports = { createProposalApplyService };