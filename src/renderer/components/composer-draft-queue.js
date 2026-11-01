// 只管理输入的保存顺序；会话切换、读取恢复和发送消费由调用方负责。
export function createComposerDraftQueue(saveDraft) {
  const states = new Map();

  function getState(sessionId) {
    const state = states.get(sessionId);
    if (!state) throw new Error("请先读取并登记该会话的输入草稿。");
    return state;
  }

  function snapshot(sessionId, state) {
    return { sessionId, text: state.text, revision: state.revision };
  }

  function register(draft) {
    // 重复或迟到读取不能覆盖本地编辑，也不能回退已确认的版本。
    if (!states.has(draft.sessionId)) {
      states.set(draft.sessionId, {
        text: draft.text,
        savedText: draft.text,
        revision: draft.revision,
        pending: null,
      });
    }
    return snapshot(draft.sessionId, getState(draft.sessionId));
  }

  function setText(sessionId, text) {
    getState(sessionId).text = text;
  }

  function flush(sessionId) {
    const state = getState(sessionId);
    if (state.pending) return state.pending;

    // 先登记 Promise，再调用保存函数，保证同一会话只有一个在途保存。
    state.pending = Promise.resolve().then(async () => {
      while (state.text !== state.savedText) {
        const text = state.text;
        const revision = state.revision;
        const result = await saveDraft(sessionId, text, revision);

        if (
          result.sessionId !== sessionId ||
          result.text !== text ||
          result.revision !== revision + 1
        ) {
          throw new Error("输入保存确认与提交内容不匹配。");
        }

        // 只更新这次确认的正文；等待期间的新输入继续留在 state.text。
        state.savedText = text;
        state.revision = result.revision;
      }
      return snapshot(sessionId, state);
    }).finally(() => {
      // 失败向调用方报告，不自动重试或猜测主进程的新版本。
      state.pending = null;
    });
    return state.pending;
  }

  return { register, setText, flush };
}