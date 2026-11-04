import { formatContextUsage } from "./session-info-panel.js";

// 只消费会话信息组件的状态，不自行读取接口或请求模型。
export function createContextUsage(element, { onRefresh, onCompact }) {
  const toggle = element.querySelector("#context-usage-toggle");
  const labelNode = element.querySelector("[data-usage-label]");
  const details = element.querySelector("#context-usage-details");
  const usageText = element.querySelector("[data-usage]");
  const announcement = element.querySelector("[data-announcement]");
  const refresh = element.querySelector("[data-refresh]");
  const compact = element.querySelector("[data-compact]");
  let state = { status: "loading" };
  let busy = true;
  let generating = false;
  let frozen = false;

  function close() {
    details.hidden = true;
    toggle.setAttribute("aria-expanded", "false");
  }

  function draw() {
    const usage = state.info?.contextUsage;
    const known = usage && usage.tokens !== null && usage.percent !== null;
    let label = "上下文读取中…";
    let text = "正在读取上下文估算……";
    let level = "normal";
    if (state.status === "ready") {
      label = known ? `上下文约 ${usage.percent.toFixed(1)}%` : "上下文待估算";
      text = formatContextUsage(usage);
      if (known && usage.percent >= 90) {
        label += " · 接近上限";
        text += "\n接近上限，可主动整理上下文；估算不会限制发送。";
        level = "high";
      } else if (known && usage.percent >= 75) {
        label += " · 用量较高";
        text += "\n用量较高，可按需整理上下文。";
        level = "high";
      }
      if (generating) {
        label += " · 生成中";
        text += "\n生成中，显示上次估算；本轮结束后更新。";
      }
    } else if (state.status === "error") {
      label = "上下文读取失败";
      text = `上下文读取失败：${state.error}；可重新读取。`;
    }
    labelNode.textContent = label;
    // 窄窗只显示环形时，无障碍名称仍保留完整文案。
    toggle.setAttribute("aria-label", label);
    // 环形指示只用百分比着色，未知或失败时保持中性。
    const percent = known ? Math.min(100, Math.max(0, usage.percent)) : 0;
    toggle.style.setProperty("--usage-percent", String(percent));
    toggle.title = text;
    toggle.disabled = frozen;
    element.dataset.level = level;
    usageText.textContent = text;
    // 只有一个温和播报区域，不在两个信息位置重复宣读。
    if (announcement.textContent !== label) announcement.textContent = label;
    refresh.disabled = busy || state.status === "loading";
    compact.disabled = busy || state.status !== "ready" || !state.info?.modelId;
  }

  toggle.addEventListener("click", () => {
    if (toggle.disabled) return;
    details.hidden = !details.hidden;
    toggle.setAttribute("aria-expanded", String(!details.hidden));
  });
  refresh.addEventListener("click", () => { if (!refresh.disabled) void onRefresh(); });
  compact.addEventListener("click", () => {
    if (compact.disabled) return;
    close();
    onCompact();
  });
  function outside(event) { if (!element.contains(event.target)) close(); }
  function escape(event) {
    if (event.key !== "Escape" || event.isComposing || details.hidden) return;
    event.preventDefault();
    event.stopPropagation();
    close();
    toggle.focus();
  }
  element.addEventListener("keydown", escape);
  element.addEventListener("focusout", event => {
    if (!element.contains(event.relatedTarget)) close();
  });
  document.addEventListener("click", outside);
  draw();
  return {
    render(next) { state = next; draw(); },
    setBusy(value, activeGeneration, freeze) {
      busy = value; generating = activeGeneration; frozen = freeze;
      if (frozen) close();
      draw();
    },
    dispose() { document.removeEventListener("click", outside); },
  };
}
