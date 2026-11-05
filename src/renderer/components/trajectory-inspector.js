// 依据 DSH 0.2.1-rc.5 TrajectoryTable 的选择、页签和分栏交互，以原生 DOM 适配 Pi 投影。
// DSH Copyright (c) 2026 DeepSeek, MIT；许可证见 docs/licenses/dsh-ui-trajectory.txt。
import { formatDuration } from "./output-trace.js";
import { renderMarkdown } from "./markdown-renderer.js";

function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, action, className = "traj-inspector-link") {
  const node = el("button", className, text);
  node.type = "button";
  node.addEventListener("click", action);
  return node;
}

function facts(rows) {
  const dl = el("dl", "traj-inspector-facts");
  for (const [label, value] of rows) {
    const row = el("div");
    const dd = el("dd");
    if (value instanceof Node) dd.append(value);
    else dd.textContent = value;
    row.append(el("dt", "", label), dd);
    dl.append(row);
  }
  return dl;
}

function markdown(text) {
  const node = el("div", "traj-markdown markdown-body");
  renderMarkdown(node, text);
  return node;
}

function raw(text) {
  const wrap = el("div", "traj-inspector-raw");
  const source = typeof text === "string" ? text : JSON.stringify(text, null, 2);
  wrap.append(button("复制", async () => {
    try {
      await navigator.clipboard.writeText(source ?? "");
      copy.textContent = "已复制";
    } catch {
      copy.textContent = "复制失败";
    }
  }, "traj-inspector-copy"));
  const copy = wrap.firstChild;
  wrap.append(el("pre", "traj-inspector-code", source ?? "未记录"));
  return wrap;
}

// 只读 JSON 树：参数/结果/Schema 都使用文本节点，外部内容不会作为 HTML 执行。
function payload(value) {
  if (typeof value === "string") {
    try { return payload(JSON.parse(value)); } catch { return raw(value); }
  }
  const host = el("div", "traj-json");
  function branch(key, item, depth) {
    if (!item || typeof item !== "object") return el("pre", "traj-json-value", `${key}${JSON.stringify(item) ?? "未记录"}`);
    const node = el("details", "traj-json-node");
    node.open = depth < 2;
    node.append(el("summary", "", `${key}${Array.isArray(item) ? `Array(${item.length})` : `{${Object.keys(item).length}}`}`));
    for (const [name, child] of Object.entries(item)) node.append(branch(`${name}: `, child, depth + 1));
    return node;
  }
  host.append(branch("", value, 0));
  const source = el("details", "traj-raw");
  source.append(el("summary", "", "原始 JSON"), raw(value));
  host.append(source);
  return host;
}

function state(record) {
  if (record.isError || record.status === "error") return "失败";
  if (record.status === "running") return "运行中";
  if (record.status === "unfinished") return "结果未确认";
  return "已完成";
}

function startedAt(ts) {
  if (!Number.isFinite(ts)) return "未记录";
  const node = button("", () => {
    unix = !unix;
    node.textContent = unix ? (ts / 1000).toFixed(3) : local;
  });
  const local = new Date(ts).toLocaleString("sv-SE", { hour12: false }) + `.${String(new Date(ts).getMilliseconds()).padStart(3, "0")}`;
  let unix = false;
  node.textContent = local;
  node.title = "点击切换本地时间 / Unix 时间戳";
  return node;
}

export function assistantTimingRows(record) {
  const timing = record.observedTiming;
  const validFirst = timing && Number.isFinite(timing.firstTokenAt) && timing.firstTokenAt >= timing.startedAt;
  const validEnd = validFirst && Number.isFinite(timing.completedAt) && timing.completedAt >= timing.firstTokenAt;
  const generationMs = validEnd ? timing.completedAt - timing.firstTokenAt : null;
  return [
    ["总时长", Number.isFinite(record.durationMs) ? `${formatDuration(record.durationMs)}（SDK）` : "未记录"],
    ["首 Token 延迟", validFirst ? `${formatDuration(timing.firstTokenAt - timing.startedAt)}（界面观察）` : "未记录"],
    ["生成", validEnd ? `${formatDuration(generationMs)}（界面观察）` : record.status === "running" ? "进行中" : "未记录"],
    ["吞吐量", generationMs > 0 && record.usage?.outputReported
      ? `${(record.usage.output / (generationMs / 1000)).toFixed(1)} tok/s（界面观察）`
      : generationMs === 0 ? "生成时长过短" : "未记录"],
  ];
}

export function createTrajectoryInspector({ onClose, onRecord, onRequest, renderReplay }) {
  const root = el("aside", "traj-inspector");
  root.setAttribute("aria-label", "轨迹记录详情");
  root.hidden = true;
  const handle = el("div", "traj-inspector-resize");
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "调整轨迹详情宽度");
  handle.title = "拖动调整宽度，双击恢复默认";
  const heading = el("div", "traj-inspector-header");
  const title = el("span", "traj-inspector-title");
  const close = button("×", () => onClose(), "traj-inspector-close");
  close.setAttribute("aria-label", "关闭轨迹详情");
  heading.append(title, close);
  const tabs = el("div", "traj-inspector-tabs");
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", "记录详情页签");
  const body = el("div", "traj-inspector-body");
  body.id = "trajectory-detail-panel";
  body.setAttribute("role", "tabpanel");
  body.tabIndex = 0;
  root.append(handle, heading, tabs, body);
  let selected = null;
  let activeTab = "overview";
  let selectionKey = "";
  let drag = null;
  const tabHistory = new Set(["overview"]);
  const thinkingOpen = new Map();

  function setWidth(next) {
    const split = root.parentElement;
    const max = Math.max(320, Math.min(720, split.clientWidth - 280));
    const width = Math.round(Math.max(320, Math.min(max, next)));
    root.style.width = `${width}px`;
    handle.setAttribute("aria-valuenow", String(width));
  }
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    drag = { x: event.clientX, width: root.getBoundingClientRect().width, id: event.pointerId };
    handle.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (drag?.id === event.pointerId) setWidth(drag.width + drag.x - event.clientX);
  });
  handle.addEventListener("pointerup", (event) => {
    if (drag?.id !== event.pointerId) return;
    drag = null;
    handle.releasePointerCapture(event.pointerId);
  });
  handle.addEventListener("pointercancel", () => { drag = null; });
  handle.addEventListener("dblclick", () => { root.style.removeProperty("width"); handle.removeAttribute("aria-valuenow"); });
  handle.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setWidth(root.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 16 : -16));
  });
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !event.isComposing) {
      event.stopPropagation();
      onClose();
    }
  });

  function availableTabs() {
    if (selected.requestOnly) return [["overview", "概述"], ["usage", "用量"], ["timing", "计时"]];
    return selected.record.kind === "tool"
      ? [["overview", "概述"], ["input", "参数"], ["output", "结果"], ["schema", "Schema"], ["timing", "计时"]]
      : [["overview", "概述"], ["rendered", "预览"], ["raw", "原始内容"]];
  }

  function activate(tab, focus = false) {
    activeTab = tab;
    tabHistory.delete(tab);
    tabHistory.add(tab);
    paintTabs();
    paintBody();
    if (focus) tabs.querySelector(`[data-tab="${tab}"]`)?.focus();
  }

  function paintTabs() {
    tabs.replaceChildren();
    const entries = availableTabs();
    for (const [id, label] of entries) {
      const tab = button(label, () => activate(id, true), "traj-inspector-tab");
      tab.dataset.tab = id;
      tab.id = `trajectory-detail-${id}`;
      tab.setAttribute("role", "tab");
      tab.setAttribute("aria-controls", body.id);
      tab.setAttribute("aria-selected", String(activeTab === id));
      tab.tabIndex = activeTab === id ? 0 : -1;
      tab.addEventListener("keydown", (event) => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const index = entries.findIndex(([value]) => value === id);
        const next = event.key === "Home" ? 0 : event.key === "End" ? entries.length - 1 : (index + (event.key === "ArrowRight" ? 1 : -1) + entries.length) % entries.length;
        activate(entries[next][0], true);
      });
      tabs.append(tab);
    }
    body.setAttribute("aria-labelledby", `trajectory-detail-${activeTab}`);
  }

  function section(label, tab, content, action) {
    const box = el("section", "traj-inspector-section");
    const head = el("h3");
    if (tab || action) head.append(button(`${label} ›`, action ?? (() => activate(tab, true))));
    else head.textContent = label;
    const preview = el("div", "traj-inspector-preview");
    preview.append(content);
    box.append(head, preview);
    return box;
  }

  function content(record, rendered) {
    const host = el("div", "traj-inspector-content");
    const blocks = record.content ?? [
      ...(record.thinking ? [{ type: "thinking", thinking: record.thinking }] : []),
      { type: "text", text: record.text ?? "" },
      ...(record.toolCalls ?? []).map((call) => ({ ...call, type: "toolCall" })),
    ];
    for (const [index, block] of blocks.entries()) {
      if (block.redacted) continue;
      if (!rendered) {
        host.append(el("h3", "traj-section-title", { thinking: "思考", text: "正文", toolCall: `工具调用 · ${block.name}` }[block.type] ?? "原文"));
        host.append(raw(block.type === "toolCall" ? { id: block.id, name: block.name, arguments: block.arguments ?? block.argumentsRaw } : block.text ?? block.thinking ?? ""));
      } else if (block.type === "thinking" && block.thinking) {
        const key = `${record.id}:${index}`;
        const thinking = el("details", "traj-inspector-thinking");
        thinking.open = thinkingOpen.get(key) ?? true;
        thinking.append(el("summary", "", "思考"), markdown(block.thinking));
        thinking.addEventListener("toggle", () => thinkingOpen.set(key, thinking.open));
        host.append(thinking);
      } else if (block.type === "text" && block.text) host.append(markdown(block.text));
      else if (block.type === "toolCall") {
        const target = selected.request.records.find((item) => item.toolCallId === block.id);
        const link = button(`⌕ ${block.name ?? "工具"} ${JSON.stringify(block.arguments ?? block.argumentsRaw ?? {})}`, () => target && onRecord(target.id));
        link.disabled = !target;
        link.title = link.textContent;
        host.append(link);
      }
    }
    if (!host.childNodes.length) host.append(el("p", "traj-note", record.status === "running" ? "等待模型输出…" : "没有可见正文。"));
    return host;
  }

  function timing(record) {
    return facts([
      ["开始时间", startedAt(record.ts)],
      ...(record.kind === "assistant" ? assistantTimingRows(record) : [["耗时", Number.isFinite(record.durationMs) ? `${formatDuration(record.durationMs)}（SDK）` : "未记录"]]),
    ]);
  }

  function paintBody() {
    body.replaceChildren();
    body.scrollTop = 0;
    const { record, request, requestOnly } = selected;
    if (requestOnly) {
      const hasUsage = request.records.some((item) => item.usage);
      const duration = request.timing?.available ? formatDuration(request.timing.totalMs) : "未记录";
      if (activeTab === "usage") {
        body.append(facts([["输入", "input"], ["输出", "output"], ["合计", "total"]].map(([label, key]) => [label, hasUsage ? String(request.usage[key]) : "未记录"])));
      } else if (activeTab === "timing") {
        body.append(facts([["开始时间", startedAt(request.startedAt)], ["本轮耗时", duration], ["计时来源", request.source === "history" ? "历史消息 / SDK 耗时" : "界面观察 / SDK 耗时"]]));
        for (const item of request.records.filter((item) => item.kind === "assistant")) {
          body.append(section("响应计时", "timing", timing(item), () => onRecord(item.id)));
        }
      } else {
        body.append(facts([["状态", request.status === "live" ? "运行中" : "已收尾"], ["记录", String(request.records.length)]]));
        body.append(section("输入", null, markdown(request.userText ?? "")));
        body.append(section("用量", "usage", facts([["合计", hasUsage ? String(request.usage.total) : "未记录"]])));
        body.append(section("本轮计时", "timing", facts([["耗时", duration]])));
      }
      return;
    }
    if (activeTab === "rendered" || activeTab === "raw") body.append(content(record, activeTab === "rendered"));
    else if (activeTab === "input") body.append(payload(record.args));
    else if (activeTab === "output") {
      body.append(payload(record.result));
      if (record.nestedCalls) body.append(el("h3", "traj-section-title", "嵌套调用"), payload(record.nestedCalls));
    }
    else if (activeTab === "schema") body.append(record.schema ? payload(record.schema) : el("p", "traj-note", "该次调用未记录工具 Schema。"));
    else if (activeTab === "timing") body.append(timing(record));
    else {
      const rows = [["来源", button(`第 ${request.index + 1} 轮 ›`, () => onRequest(request.index))], ["状态", state(record)]];
      if (record.kind === "assistant") rows.push(["Token", record.usage?.outputReported ? `${record.usage.output} tok（输出）` : "未记录"]);
      if (record.model) rows.push(["模型", `${record.provider ?? ""}/${record.model}`]);
      if (record.kind === "tool") {
        const parent = request.records.find((item) => item.kind === "assistant" && item.toolCalls?.some((call) => call.id === record.toolCallId));
        if (parent) rows.push(["助手消息", button("查看 ›", () => onRecord(parent.id))]);
        if (record.parentToolCallId) {
          const tool = request.records.find((item) => item.toolCallId === record.parentToolCallId);
          rows.push(["父调用", tool ? button("查看 ›", () => onRecord(tool.id)) : record.parentToolCallId]);
        }
      }
      body.append(facts(rows));
      if (record.errorMessage) body.append(el("p", "traj-note", record.errorMessage));
      if (record.kind === "tool") {
        if (record.skill) body.append(el("p", "traj-note", `技能：${record.skill.name}${record.skill.source ? `（${record.skill.source}）` : ""}`));
        const replay = el("div", "traj-replay");
        renderReplay(replay, record);
        if (replay.childNodes.length) body.append(replay);
        body.append(section("参数", "input", payload(record.args)), section("结果", "output", payload(record.result)));
        body.append(section("Schema", "schema", el("p", "traj-note", record.schema?.description ?? "该次调用未记录工具 Schema。")));
        if (record.nestedCalls) body.append(section("嵌套调用", "output", payload(record.nestedCalls)));
      } else body.append(section("预览", "rendered", content(record, true)));
      if (record.kind === "assistant") body.append(section("请求计时", null, timing(record), () => onRequest(request.index, "timing")));
      else if (record.kind === "tool") body.append(section("计时", "timing", timing(record)));
    }
  }

  function render(next) {
    if (!next) {
      root.hidden = true;
      selected = null;
      return;
    }
    const key = `${next.requestOnly ? "request" : "record"}:${next.record?.id ?? next.request.index}`;
    const changed = selectionKey !== key;
    const scrollTop = changed ? 0 : body.scrollTop;
    selected = next;
    selectionKey = key;
    root.hidden = false;
    if (changed) {
      const available = availableTabs();
      activeTab = [...tabHistory].reverse().find((id) => available.some(([tab]) => tab === id)) ?? "overview";
    }
    if (next.tab && availableTabs().some(([tab]) => tab === next.tab)) {
      activeTab = next.tab;
      tabHistory.delete(activeTab);
      tabHistory.add(activeTab);
    }
    title.textContent = next.requestOnly ? `第 ${next.request.index + 1} 轮` : `${{ user: "用户", assistant: "助手", tool: "工具", status: "状态" }[next.record.kind]} · 第 ${next.request.index + 1} 轮`;
    paintTabs();
    paintBody();
    body.scrollTop = scrollTop;
  }

  function reset() {
    render(null);
    selectionKey = "";
    activeTab = "overview";
    tabHistory.clear();
    tabHistory.add("overview");
    thinkingOpen.clear();
  }

  return {
    root, render, reset,
    isInteracting: () => Boolean(drag) || (!window.getSelection()?.isCollapsed && root.contains(window.getSelection()?.anchorNode)),
  };
}
