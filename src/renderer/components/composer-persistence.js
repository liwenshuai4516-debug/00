import { createComposerDrafts } from "./composer-drafts.js";
import { createComposerDraftQueue } from "./composer-draft-queue.js";

// 输入框只在这里读写；页面负责把状态显示出来并调用发送接口。
export function createComposerPersistence(input, api, onState) {
  const drafts = createComposerDrafts(input);
  const queue = createComposerDraftQueue((...args) =>
    api.saveComposerDraft(...args),
  );
  const entries = new Map();
  let currentId = null;
  let viewVersion = 0;
  let disposed = false;

  function publish(entry) {
    if (disposed || entry?.sessionId !== currentId) return;
    onState({
      sessionId: currentId,
      message: entry.dismissing
        ? "正在解除发送限制……"
        : entry.pendingCheckError
          ? `解除结果尚未确认，请重试核对：${entry.pendingCheckError.message}`
          : entry.error
            ? `输入未保存或未完成核对：${entry.error.message}`
            : entry.message,
      retryable: Boolean(entry.error || entry.pendingCheckError),
      canSend:
        entry.loaded &&
        !entry.preparing &&
        !entry.ticket &&
        !entry.pendingSend &&
        !entry.error &&
        !entry.dismissing &&
        !entry.pendingCheckError,
      canDismiss:
        entry.loaded &&
        !entry.preparing &&
        !entry.ticket &&
        Boolean(entry.pendingSend) &&
        !entry.error &&
        !entry.dismissing &&
        !entry.pendingCheckError,
      pendingSend: entry.pendingSend ? { ...entry.pendingSend } : null,
    });
  }

  function clearTimers(entry) {
    clearTimeout(entry.debounce);
    clearTimeout(entry.deadline);
    entry.debounce = null;
    entry.deadline = null;
  }

  async function save(entry) {
    clearTimers(entry);
    if (!entry.loaded) throw new Error("请先读取当前会话的输入。");
    if (entry.ticket && !entry.confirmed) {
      entry.message = "正在准备发送，新的输入稍后保存。";
      publish(entry);
      return null;
    }
    entry.message = "正在保存输入……";
    publish(entry);
    try {
      const saved = await queue.flush(entry.sessionId);
      entry.error = null;
      entry.message =
        saved.text === entry.text ? "输入已保存。" : "输入待保存。";
      publish(entry);
      return saved;
    } catch (error) {
      entry.error = error;
      publish(entry);
      throw error;
    }
  }

  function schedule(entry) {
    if (
      disposed ||
      !entry.loaded ||
      entry.error ||
      (entry.ticket && !entry.confirmed)
    )
      return;
    entry.message = "输入待保存。";
    clearTimeout(entry.debounce);
    const run = () => {
      void save(entry).catch(() => {});
    };
    entry.debounce = setTimeout(run, 300);
    // 持续输入也最多等待1秒；同一会话的实际写入由队列串行。
    if (entry.deadline === null) entry.deadline = setTimeout(run, 1000);
    publish(entry);
  }

  function onInput() {
    drafts.recordEdit();
    const entry = entries.get(currentId);
    if (!entry) return;
    entry.local = true;
    entry.text = input.value;
    if (entry.loaded) queue.setText(currentId, input.value);
    schedule(entry);
  }
  input.addEventListener("input", onInput);

  async function switchTo(sessionId) {
    const previous = entries.get(currentId);
    if (previous && input.value !== previous.text) onInput();
    if (previous && currentId !== sessionId) {
      // 切换后的保存仍归原会话；失败保留原记录，回到该会话可重试。
      if (previous.loaded && !previous.error)
        void save(previous).catch(() => {});
    }
    drafts.switchTo(sessionId);
    currentId = sessionId;
    const view = ++viewVersion;
    let entry = entries.get(sessionId);
    if (!entry) {
      entry = {
        sessionId,
        text: input.value,
        local: false,
        loaded: false,
        loading: null,
        preparing: false,
        ticket: null,
        confirmed: false,
        pendingSend: null,
        dismissing: false,
        pendingCheckError: null,
        error: null,
        message: "正在读取输入……",
        debounce: null,
        deadline: null,
      };
      entries.set(sessionId, entry);
    }
    if (entry.loaded) {
      input.value = entry.text;
      drafts.recordEdit();
      publish(entry);
      return;
    }
    const restore = drafts.beginRestore();
    if (!restore) entry.local = true;
    publish(entry);
    try {
      if (!entry.loading) {
        entry.loading = (async () => {
          const stored = await api.loadComposerDraft();
          if (stored.sessionId !== sessionId)
            throw new Error("当前对话已变化，请重新读取输入。");
          // 服务读取与核对不能因页面不回填而跳过；一致后才登记队列。
          const inspected = await api.inspectComposerSend(sessionId);
          if (
            inspected.sessionId !== sessionId ||
            inspected.revision !== stored.revision ||
            inspected.text !== stored.text
          ) {
            throw new Error("输入读取期间内容已变化，请重新读取并核对。");
          }
          queue.register(stored);
          entry.pendingSend = inspected.pendingSend;
          entry.loaded = true;
          entry.error = null;
          if (entry.local) queue.setText(sessionId, entry.text);
          else entry.text = stored.text;
          return stored;
        })().finally(() => {
          entry.loading = null;
        });
      }
      const stored = await entry.loading;
      if (!disposed && currentId === sessionId && view === viewVersion) {
        const restored = drafts.applyRestore(restore, stored);
        if (entry.local) input.value = entry.text;
        else if (!restored) {
          // 兼顾未派发 input 事件的程序赋值，不能让队列仍保留旧正文。
          entry.local = true;
          queue.setText(sessionId, input.value);
        }
        entry.text = input.value;
      }
      entry.message = entry.pendingSend
        ? "有未确认的发送原文，已保留，请先查看。"
        : "输入已读取。";
      if (entry.local) schedule(entry);
      publish(entry);
    } catch (error) {
      entry.error = error;
      publish(entry);
      throw error;
    }
  }

  async function prepareSend() {
    const entry = entries.get(currentId);
    if (
      !entry?.loaded ||
      entry.error ||
      entry.preparing ||
      entry.ticket ||
      entry.pendingSend ||
      entry.dismissing ||
      entry.pendingCheckError
    ) {
      throw new Error("输入尚未就绪，或有待确认的发送记录。");
    }
    if (input.value !== entry.text) onInput();
    entry.preparing = true;
    publish(entry);
    try {
      await save(entry);
      if (disposed || currentId !== entry.sessionId)
        throw new Error("当前页面或会话已变化，请重新发送。");
      const ticket = queue.beginSend(entry.sessionId);
      entry.ticket = ticket;
      entry.confirmed = false;
      entry.local = true;
      entry.text = "";
      input.value = "";
      // 发送清空已经由 beginSend 管理，不再次调用 queue.setText。
      drafts.recordEdit();
      entry.message = "正在准备发送，新的输入稍后保存。";
      return ticket;
    } finally {
      entry.preparing = false;
      publish(entry);
    }
  }

  function confirmConsumed(ticket, ack) {
    const entry = entries.get(ticket?.sessionId);
    if (entry?.ticket !== ticket || !queue.confirmConsumed(ticket, ack))
      return false;
    entry.confirmed = true;
    entry.pendingSend = {
      id: ack.sendId,
      text: ticket.text,
      draftRevision: ticket.revision,
    };
    void save(entry).catch(() => {});
    return true;
  }

  async function finishSend(ticket, result) {
    const entry = entries.get(ticket?.sessionId);
    if (entry?.ticket !== ticket) return false;
    if (!["completed", "stopped", "unconfirmed"].includes(result?.outcome)) {
      throw new Error("发送结果尚未确认，请重新核对。");
    }
    confirmConsumed(ticket, result.draft);
    queue.finishSend(ticket);
    entry.ticket = null;
    entry.confirmed = false;
    if (result.outcome !== "unconfirmed" && !result.warning)
      entry.pendingSend = null;
    // 请求已结束，输入补保存失败只在输入状态区报告，不改写请求结果。
    await save(entry).catch(() => {});
    return true;
  }

  async function recoverSend(ticket) {
    const entry = entries.get(ticket?.sessionId);
    if (entry?.ticket !== ticket) return false;
    try {
      const inspected = await api.inspectComposerSend(ticket.sessionId);
      if (entry.ticket !== ticket) return false;
      let reconciled = queue.reconcileSend(ticket, inspected);
      if (!reconciled && entry.confirmed) {
        reconciled = {
          ...queue.finishSend(ticket),
          status: "consumed",
          pendingSend: inspected.pendingSend,
        };
      }
      if (!reconciled) return false;
      entry.ticket = null;
      entry.confirmed = false;
      entry.pendingSend = reconciled.pendingSend;
      entry.text = reconciled.text;
      entry.error = null;
      if (!disposed && currentId === ticket.sessionId) {
        input.value = entry.text;
        drafts.recordEdit();
      }
      await save(entry).catch(() => {});
      return reconciled;
    } catch (error) {
      entry.error = error;
      publish(entry);
      throw error;
    }
  }

 // 解除结果丢失时只读取快照，不采用读取到的草稿正文或版本覆盖本地编辑。
  async function refreshPending(entry) {
    try {
      const inspected = await api.inspectComposerSend(entry.sessionId);
      const pending = inspected?.pendingSend;
      if (inspected?.sessionId !== entry.sessionId || !(pending === null || (
        typeof pending?.id === "string" && pending.id && typeof pending.text === "string"
      ))) {
        throw new Error("快照核对结果无效，请重新读取。");
      }
      entry.pendingSend = pending ? { ...pending } : null;
      entry.pendingCheckError = null;
      return !pending;
    } catch (error) {
      entry.pendingCheckError = error;
      publish(entry);
      throw error;
    }
  }

  async function dismissPendingSend(sendId) {
    const entry = entries.get(currentId);
    if (!entry?.loaded || entry.error || entry.preparing || entry.ticket || entry.dismissing || entry.pendingCheckError || !entry.pendingSend || entry.pendingSend.id !== sendId) {
      throw new Error("发送记录或输入状态已变化，请重新核对。");
    }
    entry.dismissing = true;
    publish(entry);
    try {
      try {
        const result = await api.dismissComposerSend(entry.sessionId, sendId);
        if (result?.sessionId !== entry.sessionId || result.sendId !== sendId) {
          throw new Error("解除确认与提交的编号不匹配。");
        }
        entry.pendingSend = null;
      } catch (error) {
        // 可能已经写入但没有收到返回；核对前不能假定失败，也不能重复清理。
        if (!await refreshPending(entry)) throw error;
      }
      entry.message = "发送限制已解除，当前输入已保留。";
    } finally {
      entry.dismissing = false;
      publish(entry);
    }
  }

  async function retry() {
    const entry = entries.get(currentId);
    if (!entry) return;
    if (entry.dismissing) throw new Error("请等待解除操作结束。");
    if (entry.ticket) return recoverSend(entry.ticket);
    if (!entry.loaded) return switchTo(currentId);
    // 普通重试只核对解除结果，绝不再次调用清理接口。
    if (entry.pendingCheckError) await refreshPending(entry);
    return save(entry);
  }

  // 关闭准备阶段由页面先冻结编辑和会话操作，再等待这里全部保存确认。
  async function flushAll() {
    if (disposed) throw new Error("输入组件已释放，不能确认关闭前保存。");
    const current = entries.get(currentId);
    if (current && input.value !== current.text) onInput();
    if (!current && input.value !== "") {
      throw new Error("当前输入尚未绑定会话，请先完成初始化后重试。");
    }

    // 先检查全部记录，避免把发送协调中的空返回误当成保存完成。
    for (const entry of entries.values()) {
      if (entry.loading || entry.preparing || entry.ticket || entry.dismissing) {
        throw new Error("请等待输入读取、发送协调或解除操作结束后重试保存。");
      }
      if (!entry.loaded && entry.local) {
        throw new Error("有尚未完成读取的本地输入，请回到对应会话重新读取后再保存。");
      }
    }

    // 复用各会话原有队列，等待在途写入，并显式重试之前失败的保存。
    for (const entry of entries.values()) {
      if (entry.loaded) await save(entry);
    }
  }

  function dispose() {
    disposed = true;
    viewVersion += 1;
    input.removeEventListener("input", onInput);
    for (const entry of entries.values()) clearTimers(entry);
  }

  return {
    switchTo,
    prepareSend,
    confirmConsumed,
    finishSend,
    recoverSend,
    retry,
    dismissPendingSend,
    flushAll,
    dispose,
    flush: () => {
      const entry = entries.get(currentId);
      return entry ? save(entry) : Promise.resolve(null);
    },
  };
}
