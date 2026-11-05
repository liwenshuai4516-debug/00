// 运行轨迹视图：时长概览、按轮次/调用的记录表、搜索与展开详情。
// 只读取 trajectory-model 的投影，不请求模型或重新执行工具。
import { formatDuration } from "./output-trace.js";
import { renderMarkdown } from "./markdown-renderer.js";

const MODES = [
  ["time", "时长"],
  ["turn", "轮次"],
  ["call", "调用"],
];
const MAX_RENDERED_RECORDS = 500;
const MAX_TEXT = 8000;
const MAX_TITLE = 80;

const clockFormat = new Intl.DateTimeFormat("zh-CN", {
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});
const numberFormat = new Intl.NumberFormat("zh-CN");

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function clip(text, limit = MAX_TITLE) {
  const value = typeof text === "string" ? text.trim() : "";
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 1)}…`;
}

function firstLine(text) {
  return typeof text === "string"
    ? text.split("\n").find((line) => line.trim() !== "")?.trim() ?? ""
    : "";
}

function clock(ts) {
  if (!Number.isFinite(ts)) return "—";
  try {
    return clockFormat.format(new Date(ts));
  } catch {
    return "—";
  }
}

function tokens(usage) {
  if (!usage) return "";
  const total = Number(usage.total) || Number(usage.totalTokens) || 0;
  if (total <= 0) return "";
  return `${numberFormat.format(total)} tokens`;
}

function toolTarget(args) {
  if (!args || typeof args !== "object") return "";
  if (typeof args.command === "string") return args.command;
  if (typeof args.path === "string") return args.path;
  if (typeof args.url === "string") return args.url;
  if (typeof args.file === "string") return args.file;
  return "";
}

function replayInfo(record) {
  if (record?.kind !== "tool") return null;
  if (typeof record.summaryFile === "string" && record.summaryFile.trim() !== "") {
    return { summaryFile: record.summaryFile, status: "", testCount: undefined, counts: undefined };
  }
  if (typeof record.result !== "string") return null;
  const lines = record.result.split("\n").reverse();
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    try {
      const value = JSON.parse(trimmed);
      if (typeof value?.summaryFile === "string" && value.summaryFile.trim() !== "") {
        return {
          summaryFile: value.summaryFile,
          status: typeof value.status === "string" ? value.status : "",
          testCount: Number.isInteger(value.testCount) ? value.testCount : undefined,
          counts: value.counts && typeof value.counts === "object" ? value.counts : undefined,
        };
      }
    } catch {
      // 不是回放结果行，继续检查上一行。
    }
  }
  // 少数回放器把结果 JSON 包装在日志行里；只提取路径，不猜测其他字段。
  const match = /"summaryFile"\s*:\s*("(?:\\.|[^"\\])*")/.exec(record.result);
  if (match) {
    try {
      const summaryFile = JSON.parse(match[1]);
      if (typeof summaryFile === "string" && summaryFile.trim() !== "") {
        return { summaryFile, status: "", testCount: undefined, counts: undefined };
      }
    } catch {
      // 路径转义无效时不展示回放统计。
    }
  }
  return null;
}

function replayCountsText(info) {
  const total = Number(info?.counts?.total ?? info?.testCount);
  const passed = Number(info?.counts?.passed);
  const failed = Number(info?.counts?.failed);
  if (!Number.isInteger(total) || total < 0) return "";
  const parts = [`${total} 用例`];
  if (Number.isInteger(passed)) parts.push(`${passed} 通过`);
  if (Number.isInteger(failed) && failed > 0) parts.push(`${failed} 失败`);
  return parts.join(" · ");
}

const REPLAY_STATUS_LABELS = {
  passed: "通过",
  failed: "失败",
  skipped: "跳过",
  flaky: "波动",
  timedOut: "超时",
  interrupted: "中断",
  cancelled: "取消",
  "not-run": "未运行",
  incomplete: "不完整",
  cancelled: "已取消",
  unknown: "未知",
};

function replayStatusLabel(status) {
  return REPLAY_STATUS_LABELS[status] ?? "未知";
}

function recordTitle(record) {
  if (record.kind === "tool") {
    const target = toolTarget(record.args);
    return target === ""
      ? record.toolName
      : `${record.toolName} · ${clip(target, MAX_TITLE - record.toolName.length - 3)}`;
  }
  if (record.kind === "assistant") {
    const line = firstLine(record.text);
    return line === "" ? "仅工具调用" : clip(line);
  }
  return clip(record.text || "", MAX_TITLE) || record.kind;
}

function recordMatches(record, query) {
  if (query === "") return true;
  const parts = [
    record.text,
    record.thinking,
    record.toolName,
    record.result,
    record.statusText,
  ];
  try {
    parts.push(JSON.stringify(record.args ?? ""));
  } catch {
    // 序列化失败时仍按文本字段匹配。
  }
  return parts.some((part) => typeof part === "string" && part.toLowerCase().includes(query));
}

function requestMatches(request, query) {
  return query === "" || (request.userText ?? "").toLowerCase().includes(query);
}

function toolStatus(record) {
  if (record.status === "running") return "运行中";
  if (record.status === "unfinished") return "结果未确认";
  return record.isError ? "失败" : "完成";
}

function metaText(record) {
  const parts = [];
  if (record.kind === "tool") parts.push(toolStatus(record));
  if (record.kind === "tool" || record.kind === "assistant") {
    const duration = formatDuration(record.durationMs);
    if (duration !== "—") parts.push(duration);
  }
  const token = tokens(record.usage);
  if (token) parts.push(token);
  return parts.join(" · ");
}

function badgeText(kind) {
  return { user: "用户", assistant: "助手", tool: "工具", status: "状态" }[kind] ?? "记录";
}

function preBlock(text, className = "traj-code") {
  return element("pre", className, text === "" || text === undefined ? "（空）" : text);
}

function renderRecord(record, { open, onToggle, replay, renderReplay }) {
  const details = element("details", "traj-record");
  details.dataset.kind = record.kind;
  details.dataset.recordId = record.id;
  details.open = open;
  details.addEventListener("toggle", () => onToggle(record, details.open));

  const summary = element("summary", "traj-record__head");
  summary.append(element("span", "traj-record__badge", badgeText(record.kind)));
  if (replay) summary.append(element("span", "traj-record__replay-tag", "回放"));
  summary.append(element("span", "traj-record__title", recordTitle(record)));
  if (record.kind === "tool") {
    const previewText = firstLine(record.result ?? "");
    if (previewText !== "") {
      summary.append(element("span", "traj-record__preview", `→ ${clip(previewText, 70)}`));
    }
  }
  summary.append(element("span", "traj-record__meta", metaText(record)));
  details.append(summary);

  const body = element("div", "traj-record__body");
  const meta = element("div", "traj-record__facts");
  const facts = [
    ["时间", clock(record.ts)],
    ["耗时", formatDuration(record.durationMs)],
  ];
  if (record.kind === "tool") facts.push(["状态", toolStatus(record)]);
  if (record.kind === "assistant" && record.model) facts.push(["模型", `${record.provider ? `${record.provider}/` : ""}${record.model}`]);
  if (record.usage) facts.push(["用量", `输入 ${record.usage.input} · 输出 ${record.usage.output} · 合计 ${record.usage.total}`]);
  if (record.parentToolCallId) facts.push(["父调用", record.parentToolCallId]);
  for (const [label, value] of facts) {
    const item = element("span", "traj-fact");
    item.append(element("span", "traj-fact__label", label));
    item.append(element("span", "traj-fact__value", value));
    meta.append(item);
  }
  body.append(meta);

  if (record.kind === "assistant") {
    if (record.text) {
      const text = element("div", "traj-markdown markdown-body");
      try {
        renderMarkdown(text, record.text);
      } catch {
        text.classList.remove("markdown-body");
        text.textContent = record.text;
      }
      body.append(text);
    }
    if (record.thinking) {
      const thinking = element("details", "traj-thinking");
      thinking.append(element("summary", "", "思考过程"));
      thinking.append(preBlock(record.thinking.slice(0, MAX_TEXT)));
      body.append(thinking);
    }
    if (Array.isArray(record.toolCalls) && record.toolCalls.length > 0) {
      body.append(element("p", "traj-note", `本响应发起 ${record.toolCalls.length} 次工具调用。`));
    }
  } else if (record.kind === "tool") {
    if (record.skill) {
      body.append(element("p", "traj-note", `技能：${record.skill.name}${record.skill.source ? `（${record.skill.source}）` : ""}`));
    }
    if (replay) {
      const replayBox = element("div", "traj-replay");
      replayBox.dataset.replayFor = record.id;
      body.append(replayBox);
      renderReplay?.(replayBox, record, replay, open);
    }
    const raw = element("details", "traj-raw");
    // 回放记录先展示逐测试统计，原始日志默认收起，避免长输出淹没结果。
    raw.open = !replay;
    raw.append(element("summary", "", "参数与原始结果"));
    const argsTitle = element("p", "traj-section-title", "参数");
    raw.append(argsTitle, preBlock(JSON.stringify(record.args ?? "未记录", null, 2).slice(0, MAX_TEXT)));
    raw.append(element("p", "traj-section-title", "结果"));
    raw.append(preBlock((record.result ?? "").slice(0, MAX_TEXT)));
    if (Array.isArray(record.nestedCalls?.calls) && record.nestedCalls.calls.length > 0) {
      raw.append(element("p", "traj-note", `嵌套调用 ${record.nestedCalls.calls.length} 次${record.nestedCalls.complete === false ? "（记录不完整）" : ""}。`));
    }
    body.append(raw);
  } else {
    body.append(preBlock(record.text ?? ""));
  }

  details.append(body);
  return details;
}

export function createTrajectoryView(container, options = {}) {
  let snapshot = { sessionId: "", requests: [], hasTimeline: false, totals: {} };
  let mode = "time";
  let query = "";
  const normalizedQuery = () => query.trim().toLowerCase();
  let recordsEl = null;
  let rendered = 0;
  const expanded = new Set();
  const replayCache = new Map();
  const loadReplaySummary = typeof options.loadReplaySummary === "function"
    ? options.loadReplaySummary
    : null;

  function toggleRecord(record, open) {
    if (open) {
      expanded.add(record.id);
      if (replayInfo(record)) void loadReplay(record);
    } else {
      expanded.delete(record.id);
    }
  }

  function findRecord(id) {
    for (const request of snapshot.requests) {
      for (const record of request.records) {
        if (record.id === id) return record;
      }
    }
    return null;
  }

  function updateReplayBoxes(record) {
    const info = replayInfo(record);
    if (!info) return;
    for (const box of container.querySelectorAll(`[data-replay-for="${record.id}"]`)) {
      renderReplayBox(box, record, info, replayCache.get(record.id));
    }
  }

  function loadReplay(record) {
    const info = replayInfo(record);
    if (!info || !loadReplaySummary) return;
    const current = replayCache.get(record.id);
    if (current) return;
    const sessionId = snapshot.sessionId;
    replayCache.set(record.id, { status: "loading" });
    updateReplayBoxes(record);
    Promise.resolve()
      .then(() => loadReplaySummary(info.summaryFile))
      .then((data) => {
        if (snapshot.sessionId !== sessionId) return;
        replayCache.set(record.id, { status: "ready", data });
        updateReplayBoxes(record);
      })
      .catch((error) => {
        if (snapshot.sessionId !== sessionId) return;
        replayCache.set(record.id, { status: "error", error });
        updateReplayBoxes(record);
      });
  }

  function renderReplayBox(box, record, info, state) {
    box.replaceChildren();
    const head = element("div", "traj-replay__head");
    head.append(element("span", "traj-replay__title", "回放逐测试结果"));
    const countsText = replayCountsText(state?.data?.counts ? { counts: state.data.counts, testCount: state.data.counts.total } : info);
    if (countsText) head.append(element("span", "traj-replay__meta", countsText));
    box.append(head);

    if (!loadReplaySummary) {
      box.append(element("p", "traj-note", "当前页面未接入回放统计接口。"));
      return;
    }
    if (!state) {
      box.append(element("p", "traj-note", "展开时读取逐测试耗时与错误。"));
      return;
    }
    if (state.status === "loading") {
      box.append(element("p", "traj-note", "正在读取回放结果…"));
      return;
    }
    if (state.status === "error") {
      box.append(element("p", "traj-note", `回放结果不可用：${clip(state.error?.message ?? "读取失败", 160)}`));
      const retry = element("button", "traj-replay__retry", "重新读取");
      retry.type = "button";
      retry.addEventListener("click", () => {
        replayCache.delete(record.id);
        void loadReplay(record);
      });
      box.append(retry);
      return;
    }

    const data = state.data;
    const summary = element("p", "traj-replay__summary");
    const parts = [
      `总状态：${replayStatusLabel(data.status)}`,
      `${data.counts.total} 用例`,
      `${data.counts.passed} 通过`,
      `${data.counts.failed} 失败`,
    ];
    if (data.counts.skipped > 0) parts.push(`${data.counts.skipped} 跳过`);
    summary.textContent = parts.join(" · ");
    box.append(summary);
    if (Number.isFinite(data.durationMs)) {
      box.append(element("p", "traj-note", `批次耗时 ${formatDuration(data.durationMs)}`));
    }

    if (!Array.isArray(data.tests) || data.tests.length === 0) {
      box.append(element("p", "traj-note", "摘要没有逐测试结果。"));
    } else {
      const table = element("table", "traj-replay__table");
      const thead = element("thead");
      const headRow = element("tr");
      for (const label of ["用例", "状态", "耗时", "错误"]) headRow.append(element("th", "", label));
      thead.append(headRow);
      const tbody = element("tbody");
      for (const test of data.tests) {
        const row = element("tr");
        row.dataset.status = test.status;
        const title = element("td", "traj-replay__name", test.title);
        title.title = test.title;
        row.append(title);
        row.append(element("td", "traj-replay__status", replayStatusLabel(test.status)));
        row.append(element("td", "traj-replay__duration", Number.isFinite(test.durationMs) ? formatDuration(test.durationMs) : "—"));
        const error = element("td", "traj-replay__error", test.error || "");
        error.title = test.error || "";
        row.append(error);
        tbody.append(row);
      }
      table.append(thead, tbody);
      const wrap = element("div", "traj-replay__scroll");
      wrap.append(table);
      box.append(wrap);
    }

    if (Array.isArray(data.problems) && data.problems.length > 0) {
      const problems = element("details", "traj-replay__problems");
      problems.append(element("summary", "", `问题 ${data.problems.length} 项`));
      for (const problem of data.problems) problems.append(element("p", "traj-note", problem));
      box.append(problems);
    }
  }

  function renderReplayInto(box, record, info, open) {
    const state = replayCache.get(record.id);
    renderReplayBox(box, record, info, state);
    if (open && !state) void loadReplay(record);
  }

  function requestHeader(request, { collapsible = false } = {}) {
    const summaryText = `第 ${request.index + 1} 轮`;
    const duration = request.startedAt && request.endedAt
      ? formatDuration(request.endedAt - request.startedAt)
      : "";
    const stat = [
      request.userText ? clip(request.userText.replace(/\s+/g, " "), 90) : "（无用户输入）",
      duration === "—" ? "" : duration,
      tokens(request.usage),
    ].filter(Boolean).join(" · ");

    if (!collapsible) {
      const header = element("div", "traj-request");
      header.append(element("span", "traj-request__index", summaryText));
      header.append(element("span", "traj-request__text", stat));
      return header;
    }

    const details = element("details", "traj-turn");
    const open = request.index === snapshot.requests.length - 1 || query !== "";
    details.open = open;
    const summary = element("summary", "traj-turn__head");
    summary.append(element("span", "traj-request__index", summaryText));
    summary.append(element("span", "traj-request__text", stat));
    details.append(summary);
    return details;
  }

  function renderTime() {
    for (const request of snapshot.requests) {
      const activeQuery = normalizedQuery();
      if (requestMatches(request, activeQuery) || request.records.some((record) => recordMatches(record, activeQuery))) {
        const section = element("section", "traj-section");
        section.append(requestHeader(request));
        for (const record of request.records) {
          if (!requestMatches(request, activeQuery) && !recordMatches(record, activeQuery)) continue;
          if (rendered >= MAX_RENDERED_RECORDS) return;
          rendered += 1;
          section.append(renderRecord(record, {
            open: expanded.has(record.id),
            onToggle: toggleRecord,
            replay: replayInfo(record),
            renderReplay: renderReplayInto,
          }));
        }
        recordsEl.append(section);
      }
    }
  }

  function renderTurn() {
    for (const request of snapshot.requests) {
      const activeQuery = normalizedQuery();
      const visible = requestMatches(request, activeQuery)
        ? request.records
        : request.records.filter((record) => recordMatches(record, activeQuery));
      if (visible.length === 0 && !requestMatches(request, activeQuery)) continue;
      if (rendered >= MAX_RENDERED_RECORDS) return;
      const details = requestHeader(request, { collapsible: true });
      for (const record of visible) {
        if (rendered >= MAX_RENDERED_RECORDS) return;
        rendered += 1;
        details.append(renderRecord(record, {
          open: expanded.has(record.id),
          onToggle: toggleRecord,
          replay: replayInfo(record),
          renderReplay: renderReplayInto,
        }));
      }
      recordsEl.append(details);
    }
  }

  function renderCall() {
    for (const request of snapshot.requests) {
      const activeQuery = normalizedQuery();
      const tools = request.records.filter((record) =>
        record.kind === "tool" && (requestMatches(request, activeQuery) || recordMatches(record, activeQuery)));
      if (tools.length === 0) continue;
      const section = element("section", "traj-section");
      section.append(requestHeader(request));
      for (const record of tools) {
        if (rendered >= MAX_RENDERED_RECORDS) return;
        rendered += 1;
        section.append(renderRecord(record, {
          open: expanded.has(record.id),
          onToggle: toggleRecord,
          replay: replayInfo(record),
          renderReplay: renderReplayInto,
        }));
      }
      recordsEl.append(section);
    }
  }

  function renderRecords() {
    if (!recordsEl) return;
    recordsEl.replaceChildren();
    rendered = 0;
    if (snapshot.requests.length === 0) {
      recordsEl.append(element("p", "traj-empty", "当前会话还没有轨迹。发送消息或打开有历史的对话后查看。"));
      return;
    }
    if (mode === "turn") renderTurn();
    else if (mode === "call") renderCall();
    else renderTime();

    if (rendered === 0) {
      recordsEl.append(element("p", "traj-empty", query === "" ? "没有可显示的轨迹记录。" : "没有匹配的轨迹记录。"));
    } else if (rendered >= MAX_RENDERED_RECORDS) {
      recordsEl.append(element("p", "traj-note", `记录较多，仅显示前 ${MAX_RENDERED_RECORDS} 条。`));
    }
  }

  function barsFor(records, kind) {
    return records
      .filter((record) => record.kind === kind && Number.isFinite(record.ts))
      .map((record) => {
        const duration = Number.isFinite(record.durationMs) ? record.durationMs : 0;
        return { start: record.ts, end: record.ts + Math.max(duration, 0), label: recordTitle(record), record };
      });
  }

  function focusRecord(id) {
    const record = findRecord(id);
    if (!record) return;
    if (mode !== "time" || query !== "") {
      mode = "time";
      query = "";
      render();
    }
    const node = container.querySelector(`[data-record-id="${id}"]`);
    if (!node) return;
    node.open = true;
    expanded.add(id);
    if (replayInfo(record)) void loadReplay(record);
    node.scrollIntoView({ block: "center", behavior: "smooth" });
    node.classList.add("traj-record--focus");
    window.setTimeout(() => node.classList.remove("traj-record--focus"), 1600);
  }

  function renderOverview() {
    const assistant = barsFor(snapshot.requests.flatMap((request) => request.records), "assistant");
    const tools = barsFor(snapshot.requests.flatMap((request) => request.records), "tool");
    const waits = snapshot.requests.flatMap((request) => {
      if (!Number.isFinite(request.startedAt)) return [];
      const first = request.records.find((record) => record.kind !== "user" && Number.isFinite(record.ts));
      const end = first?.ts ?? request.endedAt;
      if (!Number.isFinite(end) || end <= request.startedAt) return [];
      return [{ start: request.startedAt, end, label: `第 ${request.index + 1} 轮输入/等待`, record: request.records[0] }];
    });
    const all = [...waits, ...assistant, ...tools].filter((bar) => Number.isFinite(bar.end) && bar.end > bar.start);
    if (all.length === 0) return null;

    const min = Math.min(...all.map((bar) => bar.start));
    const max = Math.max(...all.map((bar) => bar.end));
    const span = Math.max(1, max - min);
    const box = element("section", "traj-overview");
    box.setAttribute("aria-label", "时长概览");

    const axis = element("div", "traj-axis");
    axis.append(element("span", "traj-axis__label", "时长"));
    const ticks = element("div", "traj-axis__ticks");
    for (let index = 0; index <= 3; index += 1) {
      const ratio = index / 3;
      const tick = element("span", "traj-axis__tick", formatDuration(span * ratio));
      tick.style.left = `${ratio * 100}%`;
      ticks.append(tick);
    }
    axis.append(ticks);
    box.append(axis);

    const rows = [
      ["输入", waits, "wait"],
      ["模型", assistant, "model"],
      ["工具", tools, "tool"],
    ];
    for (const [label, bars, kind] of rows) {
      const row = element("div", "traj-overview__row");
      row.append(element("span", "traj-overview__label", label));
      const track = element("div", "traj-overview__track");
      for (const bar of bars) {
        const node = element(bar.record ? "button" : "span", `traj-bar traj-bar--${kind}`);
        if (bar.record) {
          node.type = "button";
          node.dataset.recordId = bar.record.id;
        }
        node.style.left = `${((bar.start - min) / span) * 100}%`;
        node.style.width = `${Math.max(0.4, ((bar.end - bar.start) / span) * 100)}%`;
        node.title = `${bar.label} · ${clock(bar.start)} · ${formatDuration(bar.end - bar.start)}`;
        if (bar.record) {
          node.setAttribute("aria-label", `定位到 ${bar.label}，耗时 ${formatDuration(bar.end - bar.start)}`);
          node.addEventListener("click", () => focusRecord(bar.record.id));
        }
        track.append(node);
      }
      row.append(track);
      box.append(row);
    }

    if (snapshot.requests.some((request) => !Number.isFinite(request.startedAt))) {
      box.append(element("p", "traj-note", "部分历史记录缺少时间戳，未画入概览。"));
    }
    return box;
  }

  function render(next, { follow = false } = {}) {
    if (next && typeof next === "object") snapshot = next;
    const previousSession = container.dataset.sessionId ?? "";
    const sessionChanged = previousSession !== snapshot.sessionId;
    if (sessionChanged) {
      expanded.clear();
      query = "";
      replayCache.clear();
    }
    container.dataset.sessionId = snapshot.sessionId ?? "";
    const scrollTop = container.scrollTop;
    // 实时更新时若用户已在底部，继续跟随最新记录；上翻查看时不打断。
    const followLatest = container.scrollHeight - container.scrollTop - container.clientHeight <= 48;
    const focusedSearch = document.activeElement?.matches?.(".traj-search input") === true;
    const selectionStart = focusedSearch ? document.activeElement.selectionStart : null;
    const selectionEnd = focusedSearch ? document.activeElement.selectionEnd : null;
    container.replaceChildren();

    const shell = element("div", "trajectory");
    const toolbar = element("div", "traj-toolbar");
    const modes = element("div", "traj-modes", undefined);
    modes.setAttribute("role", "tablist");
    modes.setAttribute("aria-label", "轨迹视图");
    for (const [value, label] of MODES) {
      const button = element("button", "traj-mode", label);
      button.type = "button";
      button.dataset.mode = value;
      button.setAttribute("role", "tab");
      button.setAttribute("aria-selected", String(value === mode));
      button.addEventListener("click", () => {
        mode = value;
        for (const item of modes.querySelectorAll(".traj-mode")) {
          item.setAttribute("aria-selected", String(item.dataset.mode === value));
        }
        renderRecords();
      });
      modes.append(button);
    }
    toolbar.append(modes);

    const search = element("label", "traj-search");
    const input = element("input");
    input.type = "search";
    input.placeholder = "搜索轨迹";
    input.setAttribute("aria-label", "搜索轨迹");
    input.value = query;
    input.addEventListener("input", () => {
      query = input.value;
      renderRecords();
    });
    search.append(input);
    toolbar.append(search);
    shell.append(toolbar);

    const totals = snapshot.totals ?? {};
    const summary = element("p", "traj-summary");
    summary.textContent = [
      `${totals.requests ?? snapshot.requests.length} 轮`,
      `活跃用时 ${formatDuration(totals.durationMs)}`,
      totals.total > 0 ? `${numberFormat.format(totals.total)} tokens` : "",
    ].filter(Boolean).join(" · ");
    shell.append(summary);

    if (snapshot.hasTimeline) {
      const overview = renderOverview();
      if (overview) shell.append(overview);
    } else if (snapshot.requests.length > 0) {
      shell.append(element("p", "traj-note", "历史记录缺少时间戳，仅显示时长与记录列表。"));
    }

    recordsEl = element("div", "traj-records");
    shell.append(recordsEl);
    container.append(shell);
    renderRecords();
    container.scrollTop = follow || sessionChanged || followLatest ? container.scrollHeight : scrollTop;
    if (focusedSearch) {
      const searchInput = container.querySelector(".traj-search input");
      searchInput?.focus();
      if (Number.isInteger(selectionStart) && Number.isInteger(selectionEnd)) {
        searchInput?.setSelectionRange(selectionStart, selectionEnd);
      }
    }
  }

  return {
    render,
    // 搜索框聚焦（含输入法组词）时不自动重建，避免打断输入；失去焦点后的下一次事件再更新。
    isEditing: () => document.activeElement?.matches?.(".traj-search input") === true,
    isAtBottom: () => container.scrollHeight - container.scrollTop - container.clientHeight <= 48,
    scrollToLatest: () => container.scrollTo({ top: container.scrollHeight, behavior: "smooth" }),
    reset: () => render({ sessionId: "", requests: [], hasTimeline: false, totals: {} }),
  };
}
