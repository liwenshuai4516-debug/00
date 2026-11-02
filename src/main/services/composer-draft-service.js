// 输入草稿的会话归属由主进程登记，页面只提交会话编号和输入版本。
function createComposerDraftService(sessionService, sessionStateStore) {
  const knownSessions = new Map();

  async function loadCurrentDraft() {
    const session = await sessionService.getSession(true);

    // 在异步读取前固定归属，不能在保存时改用后来打开的会话。
    const sessionId = session.sessionId;
    const workspaceDir = session.sessionManager.getCwd();

    const state = await sessionStateStore.load(sessionId);

    // 异步返回后再检查，防止迟到读取覆盖已经确认的归属。
    if (
      knownSessions.has(sessionId) &&
      knownSessions.get(sessionId) !== workspaceDir
    ) {
      throw new Error("会话工作目录与已登记目录不一致。");
    }

    if (state && state.workspaceDir !== workspaceDir) {
      throw new Error("输入草稿的工作目录与当前会话不匹配。");
    }

    // 读取成功后才登记；失败时不能授权后续写入。
    knownSessions.set(sessionId, workspaceDir);

    return {
      sessionId,
      text: state?.draft.text ?? "",
      revision: state?.draft.revision ?? 0,
    };
  }

  async function saveDraft(sessionId, text, expectedRevision) {
    if (!knownSessions.has(sessionId)) {
      throw new Error("该会话尚未登记，请先读取对应会话的输入草稿。");
    }

    // 允许切换后的延迟保存，始终使用原会话已登记的目录。
    const state = await sessionStateStore.saveDraft(
      sessionId,
      knownSessions.get(sessionId),
      text,
      expectedRevision,
      // 回调只查原编号；在同次状态写入中读取来源和实际模型。
      typeof sessionService.readSessionRegistration === "function"
        ? () => sessionService.readSessionRegistration(sessionId)
        : undefined,
    );

    return {
      sessionId,
      text: state.draft.text,
      revision: state.draft.revision,
    };
  }

  async function inspectSend(sessionId) {
    if (!knownSessions.has(sessionId)) {
      throw new Error("该会话尚未登记，请先读取对应会话的输入草稿。");
    }

    // 使用原会话的登记；切换后的迟到核对不能改查新会话。
    const workspaceDir = knownSessions.get(sessionId);
    const state = await sessionStateStore.load(sessionId);
    if (state && state.workspaceDir !== workspaceDir) {
      throw new Error("输入草稿的工作目录与已登记目录不匹配。");
    }

    // 只给页面必要字段；读取不清理快照、不恢复原文，也不发送请求。
    return {
      sessionId,
      text: state?.draft.text ?? "",
      revision: state?.draft.revision ?? 0,
      pendingSend: state?.pendingSend ? {
        id: state.pendingSend.id,
        text: state.pendingSend.text,
        draftRevision: state.pendingSend.draftRevision,
      } : null,
    };
  }

  // 只由用户明确确认后的独立入口调用，不代表模型已经成功处理。
  async function dismissSend(sessionId, sendId) {
    if (!knownSessions.has(sessionId)) {
      throw new Error("该会话尚未登记，请先读取对应会话的输入草稿。");
    }
    if (typeof sendId !== "string" || !sendId) {
      throw new Error("发送编号无效。");
    }

    const workspaceDir = knownSessions.get(sessionId);
    // 历史来源尚未可靠保存时，不能先清除用于核对的发送快照。
    await sessionService.syncSessionRegistration?.(sessionId);
    await sessionStateStore.update(sessionId, workspaceDir, (state) => {
      // 在串行更新内部比较编号，迟到的确认不能清理较新的发送记录。
      if (state.pendingSend?.id !== sendId) {
        throw new Error("发送记录已变化，请重新核对后再处理。");
      }

      // 不回填原文，不改草稿版本、组织状态，也不接触Pi历史。
      return { ...state, pendingSend: null };
    });

    // 不返回可能已经过期的草稿正文，页面继续保留自己的最新编辑。
    return { sessionId, sendId };
  }

  return { loadCurrentDraft, saveDraft, inspectSend, dismissSend };
}

module.exports = { createComposerDraftService };