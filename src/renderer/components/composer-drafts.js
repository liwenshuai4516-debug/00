// 管理页面内输入及读取凭证；持久化和发送流程由调用方接入。
export function createComposerDrafts(input) {
  const drafts = new Map();
  let currentId = null;
  let initialEdited = false;
  let restoreTicket = null;

  function recordEdit() {
    // 输入过又清空也算编辑，不能只比较最后的字符串。
    restoreTicket = null;
    if (currentId === null) {
      initialEdited = true;
      return;
    }

    const state = drafts.get(currentId);
    state.text = input.value;
    state.protected = true;
  }

  function switchTo(sessionId) {
    // 同会话刷新不覆盖输入，也不打断尚未返回的读取。
    if (currentId === sessionId) return;

    if (currentId !== null) {
      const previous = drafts.get(currentId);
      if (previous.text !== input.value) recordEdit();

      if (!drafts.has(sessionId)) {
        drafts.set(sessionId, { text: "", protected: false });
      }
      input.value = drafts.get(sessionId).text;
    } else {
      // 首次绑定保留加载期间的输入，包括输入后主动清空。
      drafts.set(sessionId, {
        text: input.value,
        protected: initialEdited || input.value !== "",
      });
    }

    currentId = sessionId;
    // 即使 A → B → A，第一次访问 A 的读取也不能再生效。
    restoreTicket = null;
  }

  function beginRestore() {
    if (currentId === null) return null;
    const state = drafts.get(currentId);

    // 兼顾程序直接修改 value 的情况；事件仍负责识别输入后清空。
    if (state.text !== input.value) recordEdit();
    if (state.protected) return null;

    restoreTicket = { sessionId: currentId, text: input.value };
    return restoreTicket;
  }

  function applyRestore(ticket, draft) {
    if (!ticket || restoreTicket !== ticket) return false;
    restoreTicket = null;

    if (
      draft.sessionId !== currentId ||
      input.value !== ticket.text
    ) {
      return false;
    }

    input.value = draft.text;
    // 已恢复过的正文（包括空串）不因列表刷新再次回填。
    drafts.set(currentId, { text: draft.text, protected: true });
    return true;
  }

  function restoreAfterFailure(text) {
    // 等待回复期间的新内容和空白都不能覆盖。
    if (input.value !== "") return false;

    input.value = text;
    recordEdit();
    return true;
  }

  return {
    switchTo,
    recordEdit,
    beginRestore,
    applyRestore,
    restoreAfterFailure,
  };
}