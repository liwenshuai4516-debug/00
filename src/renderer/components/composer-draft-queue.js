// 管理保存顺序与发送消费版本；会话切换和 DOM 更新由调用方负责。
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
        sending: null,
      });
    }
    return snapshot(draft.sessionId, getState(draft.sessionId));
  }

  function setText(sessionId, text) {
    getState(sessionId).text = text;
  }

  function flush(sessionId) {
    const state = getState(sessionId);
    if (state.sending && !state.sending.consumed) {
      return Promise.reject(new Error("请等待输入消费确认后再保存。"));
    }
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

  function beginSend(sessionId) {
    const state = getState(sessionId);
    if (state.sending) throw new Error("该会话已有发送尚未结束。");
    if (state.pending || state.text !== state.savedText) {
      throw new Error("请先等待输入保存完成，再发送消息。");
    }
    if (!state.text.trim()) throw new Error("请输入消息内容。");

    // 对象身份区分每次发送；原文和版本固定后，等待确认期间只缓存新输入。
    const ticket = Object.freeze(snapshot(sessionId, state));
    state.sending = { ticket, consumed: false };
    state.text = "";
    return ticket;
  }

  function findSending(ticket) {
    const state = states.get(ticket?.sessionId);
    return state?.sending?.ticket === ticket ? state : null;
  }

  function confirmConsumed(ticket, ack) {
    const state = findSending(ticket);
    if (
      !state || state.sending.consumed ||
      ack?.sessionId !== ticket.sessionId ||
      typeof ack.sendId !== "string" || !ack.sendId ||
      ack.text !== "" || ack.revision !== ticket.revision + 1
    ) {
      return false;
    }

    // 确认只推进已保存基线，不能清空确认等待期间的新输入。
    state.savedText = "";
    state.revision = ack.revision;
    state.sending.consumed = true;
    return true;
  }

  function finishSend(ticket) {
    const state = findSending(ticket);
    if (!state) return false;
    if (!state.sending.consumed) {
      throw new Error("尚未确认输入消费，不能结束本次发送协调。");
    }
    state.sending = null;
    return snapshot(ticket.sessionId, state);
  }

  function rejectBeforeConsume(ticket) {
    const state = findSending(ticket);
    if (!state) return false;
    if (state.sending.consumed) {
      throw new Error("输入已消费，不能按消费前失败恢复。");
    }

    // 仅用于已确定未消费的失败；结果未知时必须保留等待状态。
    if (state.text === "") state.text = ticket.text;
    state.sending = null;
    return snapshot(ticket.sessionId, state);
  }

  return {
    register, setText, flush,
    beginSend, confirmConsumed, finishSend, rejectBeforeConsume,
  };
}