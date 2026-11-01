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
    // 原有调用可传固定目录；应用入口传函数，读取当前会话目录。
    const currentWorkspaceDir =
      typeof workspaceDir === "function" ? await workspaceDir() : workspaceDir;

    if (proposal.kind === "create-proposal") {
      const { resolveNewFilePath } =
        await import("../workspace/resolve-new-file-path.mjs");

      // 草稿生成后目标可能已被占用，审阅时重新检查路径。
      // 此处只校验，不创建目录或文件。
      await resolveNewFilePath(currentWorkspaceDir, proposal.path);
      return proposal;
    }

    if (proposal.kind !== "edit-proposal") {
      throw new Error("不支持审阅该草稿类型。");
    }

    const { createReadTextFileTool } =
      await import("../tools/read-text-file.mjs");

    // 复用已有的路径、文件类型和大小限制。
    const reader = createReadTextFileTool(currentWorkspaceDir);
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

    // 以完整行扩展替换范围，保留行内前后缀及前后各两行上下文。
    // 行尾属于原文，不能统一换行，也不把末尾换行算成额外空行。
    const lines = Array.from(
      source.matchAll(/[^\r\n]*(?:\r\n|\r|\n|$)/g),
    ).filter((line) => line[0] !== "");

    const replacementEnd = index + proposal.oldText.length;
    const firstLine = lines.findIndex(
      (line) => index < line.index + line[0].length,
    );
    const lastLine = lines.findIndex(
      (line) => replacementEnd <= line.index + line[0].length,
    );

    const startLineIndex = Math.max(0, firstLine - 2);
    const endLineIndex = Math.min(lines.length - 1, lastLine + 2);
    const start = lines[startLineIndex].index;
    const end = lines[endLineIndex].index + lines[endLineIndex][0].length;

    // 仅扩展本次审阅响应，不改写草稿，也不用于替代保存前的再次复核。
    return {
      ...proposal,
      review: {
        startLine: startLineIndex + 1,
        oldText: source.slice(start, end),
        newText:
          source.slice(start, index) +
          proposal.newText +
          source.slice(replacementEnd, end),
      },
    };
  }

  return { review };
}

module.exports = { createProposalReviewService };
