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
        editVersion: 0,
      });
    }
    return snapshot(draft.sessionId, getState(draft.sessionId));
  }

  function setText(sessionId, text) {
    const state = getState(sessionId);
    state.text = text;
    // 同样的空串也可能来自主动清空，不能仅靠正文判断是否编辑过。
    state.editVersion += 1;
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
    state.sending = { ticket, consumed: false, editVersion: state.editVersion };
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
    if (state.text === "" && state.editVersion === state.sending.editVersion) {
      state.text = ticket.text;
    }
    state.sending = null;
    return snapshot(ticket.sessionId, state);
  }

  function reconcileSend(ticket, inspected) {
    const state = findSending(ticket);
    // 旧凭证或已通过事件确认的发送，不能再用较早的读取结果改写。
    if (!state || state.sending.consumed) return false;

    const pending = inspected?.pendingSend;
    if (
      inspected?.sessionId !== ticket.sessionId ||
      typeof inspected.text !== "string" ||
      !Number.isSafeInteger(inspected.revision) ||
      inspected.revision < 0 ||
      !(pending === null || (
        typeof pending?.id === "string" && pending.id &&
        typeof pending.text === "string" && pending.text.trim() &&
        Number.isSafeInteger(pending.draftRevision) &&
        pending.draftRevision >= 0 && pending.draftRevision < inspected.revision
      ))
    ) {
      throw new Error("发送状态核对结果无效，请保留输入并重新核对。");
    }

    const pendingSend = pending ? { ...pending } : null;
    if (inspected.revision === ticket.revision && inspected.text === ticket.text) {
      // 原文和版本均未改变，才可确定本次发送尚未消费。
      return { ...rejectBeforeConsume(ticket), status: "not-consumed", pendingSend };
    }

    if (
      inspected.revision !== ticket.revision + 1 || inspected.text !== "" ||
      (pending && (pending.draftRevision !== ticket.revision || pending.text !== ticket.text))
    ) {
      // 其他版本或正文变化不自动合并，维持暂停以免覆盖外部状态。
      throw new Error("发送状态与本次原文或版本不匹配，请保留输入并重新核对。");
    }

    state.savedText = "";
    state.revision = inspected.revision;
    state.sending = null;
    // 空快照只证明版本已前进，不能据此宣称模型请求成功。
    return {
      ...snapshot(ticket.sessionId, state),
      status: pending ? "consumed" : "advanced",
      pendingSend,
    };
  }

  return {
    register, setText, flush,
    beginSend, confirmConsumed, finishSend, rejectBeforeConsume, reconcileSend,
  };
}