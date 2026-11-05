import { formatContextUsage } from "./session-info-panel.js";

// 只消费会话信息组件的状态，不自行读取接口或请求模型。
export function createContextUsage(element, { onRefresh, onCompact, loadBreakdown }) {
  const toggle = element.querySelector("#context-usage-toggle");
  const labelNode = element.querySelector("[data-usage-label]");
  const details = element.querySelector("#context-usage-details");
  const usageText = element.querySelector("[data-usage]");
  const breakdownBox = element.querySelector("[data-breakdown]");
  const breakdownBar = element.querySelector("[data-breakdown-bar]");
  const breakdownStatus = element.querySelector("[data-breakdown-status]");
  const breakdownRows = new Map();
  for (const node of element.querySelectorAll("[data-breakdown-row]")) {
    breakdownRows.set(node.dataset.breakdownRow, {
      token: node.querySelector("[data-breakdown-tokens]"),
      percent: node.querySelector("[data-breakdown-percent]"),
    });
  }
  const announcement = element.querySelector("[data-announcement]");
  const refresh = element.querySelector("[data-refresh]");
  const compact = element.querySelector("[data-compact]");
  let state = { status: "loading" };
  let busy = true;
  let generating = false;
  let frozen = false;
  let breakdown = null;
  let breakdownState = "idle";
  let breakdownError = "";
  let breakdownSessionId = null;
  let breakdownRequest = 0;

  function formatTokenCount(value) {
    return Number.isFinite(value) ? value.toLocaleString("zh-CN") : "—";
  }

  function drawBreakdown() {
    if (!breakdownBox || !breakdownBar || !breakdownStatus) return;
    const ready = state.status === "ready";
    if (!ready) {
      breakdownBox.hidden = true;
      breakdownStatus.hidden = false;
      breakdownStatus.textContent = state.status === "error" ? "上下文读取失败，暂不能估算构成。" : "正在读取上下文……";
      return;
    }
    if (breakdownState === "loading") {
      breakdownBox.hidden = true;
      breakdownStatus.hidden = false;
      breakdownStatus.textContent = "正在估算上下文构成……";
      return;
    }
    if (breakdownState === "error") {
      breakdownBox.hidden = true;
      breakdownStatus.hidden = false;
      breakdownStatus.textContent = `上下文构成读取失败：${breakdownError}。`;
      return;
    }
    if (!breakdown || breakdown.totalTokens <= 0) {
      breakdownBox.hidden = true;
      breakdownStatus.hidden = false;
      breakdownStatus.textContent = breakdown ? "没有可估算的上下文内容。" : "展开上下文详情后读取构成。";
      return;
    }

    breakdownBox.hidden = false;
    breakdownStatus.hidden = true;
    const total = breakdown.totalTokens;
    const parts = [
      ["system", breakdown.systemTokens, "系统提示词"],
      ["tools", breakdown.toolsTokens, "工具定义"],
      ["messages", breakdown.messageTokens, "消息与工具结果"],
    ];
    breakdownBar.replaceChildren(...parts
      .filter(([, value]) => Number.isFinite(value) && value > 0)
      .map(([key, value]) => {
        const segment = document.createElement("span");
        segment.className = "context-breakdown__segment";
        segment.dataset.segment = key;
        segment.style.flexGrow = String(value);
        return segment;
      }));
    breakdownBar.setAttribute(
      "aria-label",
      `上下文构成：${parts.map(([, value, label]) => `${label} ${formatTokenCount(value)}`).join("，")}`,
    );
    for (const [key, value] of parts) {
      const row = breakdownRows.get(key);
      if (!row) continue;
      row.token.textContent = formatTokenCount(value);
      row.percent.textContent = `${Math.round((value / total) * 100)}%`;
    }
  }

  async function loadBreakdownData() {
    if (typeof loadBreakdown !== "function") {
      breakdownState = "error";
      breakdownError = "当前版本未提供构成估算接口";
      drawBreakdown();
      return;
    }
    const request = ++breakdownRequest;
    breakdownState = "loading";
    breakdownError = "";
    drawBreakdown();
    try {
      const result = await loadBreakdown();
      if (request !== breakdownRequest) return;
      if (!result || !Number.isFinite(result.totalTokens)) {
        throw new Error("返回的构成数据无效");
      }
      breakdown = result;
      breakdownState = "ready";
    } catch (error) {
      if (request !== breakdownRequest) return;
      breakdown = null;
      breakdownState = "error";
      breakdownError = error.message;
    }
    drawBreakdown();
  }

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
    drawBreakdown();
  }

  toggle.addEventListener("click", () => {
    if (toggle.disabled) return;
    const open = details.hidden;
    details.hidden = !open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open && breakdownState === "idle" && state.status === "ready") {
      void loadBreakdownData();
    }
  });
  refresh.addEventListener("click", async () => {
    if (refresh.disabled) return;
    await onRefresh();
    if (!details.hidden) await loadBreakdownData();
  });
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
    render(next) {
      const sessionId = next.info?.sessionId ?? null;
      if (sessionId !== breakdownSessionId) {
        breakdownSessionId = sessionId;
        breakdown = null;
        breakdownState = "idle";
        breakdownError = "";
        breakdownRequest += 1;
      }
      state = next;
      draw();
      if (!details.hidden && breakdownState === "idle" && state.status === "ready") {
        void loadBreakdownData();
      }
    },
    setBusy(value, activeGeneration, freeze) {
      busy = value; generating = activeGeneration; frozen = freeze;
      if (frozen) close();
      draw();
    },
    dispose() {
      breakdownRequest += 1;
      document.removeEventListener("click", outside);
    },
  };
}
