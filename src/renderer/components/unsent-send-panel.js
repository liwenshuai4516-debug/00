// 无历史条目只做只读核对和显式清理，始终不绑定到当前输入组件。
export function createUnsentSendPanel(dialog, api, runOperation, onResolved) {
  const find = name => dialog.querySelector(`[data-${name}]`);
  const status = find("status");
  const confirm = find("confirm");
  const dismiss = find("dismiss");
  const accept = find("accept");
  const cancel = find("cancel-confirm");
  let targetId = null;
  let snapshot = null;
  let version = 0;
  let busy = false;
  let opener = null;

  function setBusy(value) {
    busy = value;
    for (const button of dialog.querySelectorAll("button")) button.disabled = value;
    dismiss.disabled = value || !snapshot;
    accept.disabled = value || !snapshot;
    dismiss.setAttribute("aria-expanded", String(!confirm.hidden));
  }

  async function reload() {
    if (busy || !targetId) return;
    const request = ++version;
    snapshot = null;
    confirm.hidden = true;
    find("pending-text").textContent = "";
    find("draft-text").textContent = "";
    find("workspace").textContent = "";
    status.textContent = "正在核对……";
    setBusy(busy);
    try {
      await runOperation(async () => {
        const result = await api.inspectUnsentSend(targetId);
        if (request !== version || !dialog.open) return;
        if (result.sessionId !== targetId || !result.pendingSend?.id) {
          throw new Error("核对结果归属无效，请重新核对。");
        }
        snapshot = result;
        find("workspace").textContent = `工作目录：${result.workspaceDir}`;
        find("pending-text").textContent = result.pendingSend.text;
        find("draft-text").textContent = result.text;
        status.textContent = "仅供核对；没有切换当前对话或发送消息。";
      });
    } catch (error) {
      if (request === version && dialog.open) status.textContent = `核对失败：${error.message}`;
    }
    setBusy(busy);
  }

  find("reload").addEventListener("click", () => { void reload(); });
  dismiss.addEventListener("click", () => {
    if (busy || !snapshot) return;
    confirm.hidden = false;
    setBusy(busy);
    cancel.focus();
  });
  cancel.addEventListener("click", () => {
    if (busy) return;
    confirm.hidden = true;
    setBusy(busy);
    dismiss.focus();
  });
  accept.addEventListener("click", async () => {
    if (busy || !snapshot || confirm.hidden) return;
    const target = snapshot;
    snapshot = null;
    confirm.hidden = true;
    try {
      await runOperation(async () => {
        const result = await api.dismissUnsentSend(target.sessionId, target.pendingSend.id);
        if (result.sessionId !== target.sessionId || result.sendId !== target.pendingSend.id) {
          throw new Error("清理结果归属无效，请重新核对。");
        }
        status.textContent = "快照已清理，另存输入已保留；没有恢复或重新发送。";
        // 清理已经落盘，刷新失败不能误报为清理失败或自动重试清理。
        try { await onResolved(); }
        catch (error) { status.textContent += `列表刷新失败：${error.message}`; }
      });
    } catch (error) {
      status.textContent = `清理结果未确认，请重新核对：${error.message}`;
    }
    setBusy(busy);
    find("close").focus();
  });
  find("close").addEventListener("click", () => { if (!busy) dialog.close(); });
  dialog.addEventListener("cancel", event => {
    if (busy || event.isComposing) event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    // close 事件异步派发；快速重开后，旧事件不能作废新的核对。
    if (dialog.open) return;
    version += 1;
    targetId = null;
    snapshot = null;
    if (opener?.isConnected && !opener.disabled) opener.focus();
    else document.getElementById("message-input")?.focus();
  });
  window.addEventListener("pagehide", () => { version += 1; }, { once: true });

  return {
    setBusy,
    open(sessionId) {
      if (busy || dialog.open) return;
      opener = document.activeElement;
      targetId = sessionId;
      dialog.showModal();
      void reload();
    },
  };
}
