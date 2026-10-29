const { createHash } = require("node:crypto");

// 负责审阅前校验，不依赖 Electron 或页面。
function createProposalReviewService(workspaceDir, chatService) {
  async function review(id) {
    // 根据编号读取主进程保存的草稿，同时校验当前会话归属。
    const proposal = await chatService.getProposal(id);
    if (proposal.written) {
      throw new Error("该草稿已经保存，无需重复保存。");
    }

    if (proposal.applying) {
      throw new Error("上次保存未确认完成，请检查文件并重新生成草稿。");
    }

    const { createReadTextFileTool } =
      await import("../tools/read-text-file.mjs");

    // 复用已有的路径、文件类型和大小限制。
    const reader = createReadTextFileTool(workspaceDir);
    const result = await reader.execute("review-proposal", {
      path: proposal.path,
    });

    const source = result.details.text;
    const currentHash = createHash("sha256")
      .update(source, "utf8")
      .digest("hex");

    // 比较整个文本，而不只是待替换的那一段。
    if (currentHash !== proposal.baseTextHash) {
      throw new Error("文件已发生变化，请重新读取文件并生成草稿。");
    }

    const index = source.indexOf(proposal.oldText);

    if (
      !proposal.oldText ||
      index === -1 ||
      source.indexOf(proposal.oldText, index + 1) !== -1
    ) {
      throw new Error("草稿不能唯一定位原文，请重新生成。");
    }

    return proposal;
  }

  return { review };
}

module.exports = { createProposalReviewService };
