// 撤销提示只影响归档标记；停留或聚焦时暂停计时，避免入口突然消失。
export function createArchiveNotice(onUndo) {
  const element = document.createElement("div");
  element.className = "archive-notice";
  element.hidden = true;
  const message = document.createElement("span");
  message.setAttribute("role", "status");
  message.textContent = "已归档该对话。";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = "撤销";
  element.append(message, button);
  let target = null;
  let timer;
  let remaining = 8000;
  let started = 0;
  let hovered = false;
  let busy = false;

  function pause() {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    remaining -= performance.now() - started;
  }
  function resume() {
    pause();
    if (!target || hovered || busy || element.contains(document.activeElement)) return;
    started = performance.now();
    timer = setTimeout(clear, Math.max(0, remaining));
  }
  function clear() {
    pause();
    target = null;
    element.hidden = true;
  }
  element.addEventListener("pointerenter", () => { hovered = true; pause(); });
  element.addEventListener("pointerleave", () => { hovered = false; resume(); });
  element.addEventListener("focusin", pause);
  element.addEventListener("focusout", () => queueMicrotask(resume));
  button.addEventListener("click", () => { if (!busy && target) onUndo(target); });
  return {
    element,
    show(id) { pause(); target = id; remaining = 8000; element.hidden = false; resume(); },
    restored(id) { if (target === id) clear(); },
    setBusy(value) { busy = value; button.disabled = value; resume(); },
    dispose: clear,
  };
}
