import { appendMessage, updateAssistantMessage } from "./message-view.js";

function element(tag, className, text) {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function disclosure(parent, className) {
  const node = element("details", className);
  const summary = element("summary", "");
  const body = element("div", "trace-body");
  node.append(summary, body);
  parent.append(node);
  return { node, summary, body };
}

const textContent = content => (content ?? []).filter(block => block.type === "text").map(block => block.text).join("");
const json = value => value === undefined ? "未记录" : JSON.stringify(value, null, 2);
// 仅截断页面预览，不改写 SDK 保存和模型收到的内容。
const preview = value => value.length > 12000 ? `${value.slice(0, 12000)}\n……显示已截断` : value;
const duration = milliseconds => milliseconds < 1000 ? `${Math.round(milliseconds)} ms` : `${(milliseconds / 1000).toFixed(1)} s`;

function summarySpan(className, text) {
  const node = document.createElement("span");
  node.className = className;
  node.textContent = text;
  return node;
}

// 摘要只取一行纯文本；参数来自模型，不当作 HTML 或 Markdown 解释。
function oneLine(text, limit = 72) {
  if (typeof text !== "string") return "";
  const line = text.split("\n").find(value => value.trim() !== "")?.trim() ?? "";
  return line.length > limit ? `${line.slice(0, limit - 1)}…` : line;
}

function firstLine(text) {
  const newline = text.indexOf("\n");
  return newline === -1 ? text : text.slice(0, newline);
}

// 运行中预览最近完成段落的首行，避免停在半句话中间；结束后取首行。
function latestParagraphLine(text) {
  let summary = "";
  let start = 0;
  const separator = /\r?\n(?:[\t ]*\r?\n)+/g;
  while (true) {
    const next = separator.exec(text);
    const end = next === null ? text.length : next.index;
    const newline = text.indexOf("\n", start);
    if (newline !== -1 && newline <= end) {
      const candidate = text.slice(start, newline).trim();
      if (candidate !== "") summary = candidate;
    }
    if (next === null) return summary === "" ? firstLine(text) : summary;
    start = next.index + next[0].length;
  }
}

// 折叠预览不保留 Markdown 强调标记，并截断过长首行。
const thinkingPreview = (text, running) => {
  const line = (running ? latestParagraphLine(text) : firstLine(text)).replaceAll("**", "").trim();
  return line.length > 80 ? `${line.slice(0, 79)}…` : line;
};

// 工具行优先展示命令或文件路径，其后才是状态与耗时。
function toolDetail(name, args) {
  if (!args || typeof args !== "object") return "";
  if (name === "bash" || name === "pwsh") return oneLine(args.command);
  const path = typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : "";
  if (path) return oneLine(path);
  return oneLine(args.description || args.pattern || args.query || "");
}

const lineCount = text => typeof text === "string" && text !== "" ? text.split("\n").length : 0;

// 先裁掉公共前后缀再统计，避免把 edit 的上下文行算进变更数。
function lineDelta(before, after) {
  const oldLines = (typeof before === "string" ? before : "").split("\n");
  const newLines = (typeof after === "string" ? after : "").split("\n");
  let start = 0;
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++;
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }
  return { removed: oldEnd - start, added: newEnd - start };
}

// write 是整文件替换；edit 按 edits[] 汇总。两者都只用于展示。
function changeStat(name, args) {
  if (!args || typeof args !== "object") return null;
  if (name === "write") {
    const added = lineCount(args.content);
    return added > 0 ? { added, removed: 0 } : null;
  }
  if (name !== "edit") return null;
  const edits = Array.isArray(args.edits)
    ? args.edits
    : typeof args.oldText === "string" || typeof args.newText === "string"
      ? [{ oldText: args.oldText, newText: args.newText }]
      : [];
  const total = edits.reduce((stat, edit) => {
    const delta = lineDelta(edit?.oldText, edit?.newText);
    return { added: stat.added + delta.added, removed: stat.removed + delta.removed };
  }, { added: 0, removed: 0 });
  return total.added || total.removed ? total : null;
}

const MAX_CARD_LINES = 200;

// 退出码优先用结构化结果；历史记录只保存结果文本，从 Pi 追加的结束语读取。
function exitCodeOf(call) {
  if (Number.isInteger(call.exitCode)) return call.exitCode;
  const match = /(?:^|\n)Command exited with code (\d+)\s*$/u.exec(call.result ?? "");
  return match ? Number(match[1]) : undefined;
}

// 只对结构确定的工具生成卡片；其余继续走通用参数/结果。
function toolCard(call) {
  const args = call.args ?? {};
  const name = call.name;
  const text = call.result ?? "";
  if (name === "bash" || name === "pwsh") {
    if (typeof args.command !== "string" || args.command.trim() === "") return null;
    return { kind: "terminal", command: args.command, output: text, exitCode: exitCodeOf(call) };
  }
  if (name === "read") {
    if (typeof args.path !== "string" || args.path.trim() === "") return null;
    return {
      kind: "read", path: args.path, text,
      offset: Number.isInteger(args.offset) && args.offset > 0 ? args.offset : 1,
      limit: Number.isInteger(args.limit) && args.limit > 0 ? args.limit : undefined,
    };
  }
  if (name === "write") {
    if (typeof args.path !== "string" || typeof args.content !== "string") return null;
    return { kind: "write", path: args.path, content: args.content };
  }
  if (name === "edit") {
    if (typeof args.path !== "string" || args.path.trim() === "") return null;
    const edits = (Array.isArray(args.edits) ? args.edits : [])
      .filter(edit => typeof edit?.oldText === "string" && typeof edit?.newText === "string");
    const diff = typeof call.diff === "string" ? call.diff : "";
    if (diff === "" && edits.length === 0) return null;
    return { kind: "diff", path: args.path, diff, edits };
  }
  return null;
}

// Pi 的 edit 差异文本以 +、- 或空格开头，并自带行号；缺失时按参数逐段还原。
function diffRows(card) {
  if (card.diff !== "") {
    return card.diff.split("\n").map(text => ({
      kind: text.startsWith("+") ? "add" : text.startsWith("-") ? "del" : "context",
      text,
    }));
  }
  const rows = [];
  for (const edit of card.edits) {
    if (rows.length > 0) rows.push({ kind: "gap", text: "……" });
    for (const line of edit.oldText.split("\n")) rows.push({ kind: "del", text: `-${line}` });
    for (const line of edit.newText.split("\n")) rows.push({ kind: "add", text: `+${line}` });
  }
  return rows;
}

function cappedRows(rows) {
  if (rows.length <= MAX_CARD_LINES) return rows;
  return [...rows.slice(0, MAX_CARD_LINES), { kind: "gap", text: `……共 ${rows.length} 行，页面仅显示前 ${MAX_CARD_LINES} 行` }];
}

function linesBlock(rows) {
  const box = element("div", "trace-lines");
  for (const row of rows) {
    // 空行保留一个空格，横向滚动与行高才稳定。
    box.append(element("div", `trace-line trace-line-${row.kind}`, row.text === "" ? " " : row.text));
  }
  return box;
}

function renderCard(call, card) {
  const node = element("div", "trace-card");
  node.dataset.kind = card.kind;
  const header = element("div", "trace-card-header");
  header.append(element("span", "trace-card-path", card.kind === "terminal" ? `$ ${oneLine(card.command, 120)}` : card.path));

  if (card.kind === "terminal") {
    if (card.exitCode !== undefined) {
      header.append(element("span", card.exitCode === 0 ? "trace-exit trace-exit-ok" : "trace-exit trace-exit-bad", `exit ${card.exitCode}`));
    }
  } else if (card.kind === "read") {
    header.append(element("span", "trace-card-meta", card.limit ? `第 ${card.offset} 行起 · 最多 ${card.limit} 行` : `第 ${card.offset} 行起`));
  } else {
    const stat = changeStat(card.kind === "diff" ? "edit" : "write", call.args);
    const label = stat && [stat.added && `+${stat.added}`, stat.removed && `-${stat.removed}`].filter(Boolean).join(" ");
    if (label) header.append(element("span", "trace-card-meta", label));
  }
  node.append(header);

  if (card.kind === "terminal") {
    node.append(element("pre", "trace-terminal", preview(card.output || "（尚无输出）")));
  } else if (card.kind === "read") {
    node.append(element("pre", "trace-read", preview(card.text || "（尚无内容）")));
  } else if (card.kind === "write") {
    const rows = card.content.split("\n").map(line => ({ kind: "add", text: `+${line}` }));
    node.append(linesBlock(cappedRows(rows)));
  } else {
    node.append(linesBlock(cappedRows(diffRows(card))));
  }
  return node;
}

export function createOutputTrace(container, { historical = false, onUpdate = () => {} } = {}) {
  const root = element("section", "output-run");
  container.append(root);
  const trace = disclosure(root, "output-trace");
  const turns = [], responses = [], calls = new Map(), dirty = new Set();
  const startedAt = performance.now();
  let endedAt, timer;
  let turn, message, frame, messageSerial = 0, finished = false, settled = false, disposed = false;
  let state = historical ? "历史恢复" : "处理中";
  let phase = "正在准备请求";
  trace.node.open = !historical;
  trace.summary.title = "本次用时、实时响应和思考阶段为界面观察计时；结束后的响应与工具耗时优先使用 Pi SDK durationMs。";

  function renderSummary() {
    const running = !historical && endedAt === undefined;
    trace.node.dataset.running = String(running);
    const activeCalls = [...new Set(calls.values())].filter(call => call.startedAt !== undefined && !call.done);
    const activity = activeCalls.length ? `正在调用 ${[...new Set(activeCalls.map(call => call.name))].join("、")}` : phase;
    trace.summary.textContent = historical
      ? `处理过程 · ${turns.length} 条响应记录 · 历史恢复`
      : `处理过程 · ${running ? activity : state} · 用时 ${duration((endedAt ?? performance.now()) - startedAt)} · ${turns.length} turn`;
  }

  function flush() {
    frame = undefined;
    renderSummary();
    for (const render of dirty) render();
    dirty.clear();
    onUpdate();
  }

  function schedule(render) {
    if (disposed) return;
    if (render) dirty.add(render);
    if (frame === undefined) frame = requestAnimationFrame(flush);
  }

  function lifecycle(type, label) {
    trace.body.append(element("p", "trace-event", `${type} · ${label}`));
  }

  function startTurn() {
    archiveResponse();
    const view = disclosure(trace.body, "trace-turn");
    view.node.open = !historical;
    turn = { ...view, index: turns.length + 1, state: historical ? "历史记录" : "进行中" };
    const current = turn;
    current.render = () => {
      current.summary.textContent = `${historical ? "响应记录" : "Turn"} ${current.index} · ${current.state}`;
    };
    turns.push(turn);
    message = undefined;
    schedule(current.render);
  }

  function ensureMessage() {
    if (!turn) startTurn();
    if (message) return message;
    const current = { blocks: [], thinking: new Map(), turn, body: null, serial: ++messageSerial,
      startedAt: historical ? undefined : performance.now(), endedAt: undefined, completed: false };
    const meta = element("p", "trace-meta");
    turn.body.append(meta);
    current.renderTiming = () => {
      const info = current.info ?? {};
      const responseDuration = current.completed && info.durationMs !== undefined
        ? `响应耗时 ${duration(info.durationMs)}（SDK）`
        : current.startedAt !== undefined ? `响应${current.endedAt !== undefined ? "用时" : "中"} ${duration((current.endedAt ?? performance.now()) - current.startedAt)}（界面计时）` : "响应耗时未记录";
      meta.textContent = [info.provider && `${info.provider}/${info.model}`, current.completed && info.stopReason && `结束原因 ${info.stopReason}`,
        responseDuration,
        info.usage && `${info.usage.totalTokens ?? "未知"} tokens（输入 ${info.usage.input ?? "未知"} / 输出 ${info.usage.output ?? "未知"}）`,
        info.errorMessage].filter(Boolean).join(" · ");
      for (const [index, view] of current.thinking) {
        const block = current.blocks[index];
        const running = view.endedAt === undefined && !historical;
        const timing = view.startedAt === undefined ? "" : ` · ${duration((view.endedAt ?? performance.now()) - view.startedAt)}（界面计时）`;
        const label = block?.redacted
          ? "思考 · 供应商未公开内容"
          : ["思考", thinkingPreview(block?.thinking ?? "", running)].filter(Boolean).join(" · ");
        view.summary.textContent = `${label}${timing}`;
        // 运行中的思考行保留状态标记，供样式区分正在生成与已结束。
        view.node.dataset.running = String(running);
      }
    };
    current.render = () => {
      const text = textContent(current.blocks);
      if (text && !current.body) current.body = appendMessage(root, "assistant", "");
      if (current.body) {
        current.body.parentElement.hidden = !text;
        // 未完成的消息保留流式标记，样式据此显示光标。
        current.body.parentElement.dataset.streaming = String(!current.completed && !historical);
        updateAssistantMessage(current.body, text);
        if (current !== message || current.hasToolCalls) placeInProcess(current);
      }
      current.renderTiming();
      for (const [index, view] of current.thinking) {
        const block = current.blocks[index];
        view.node.hidden = block?.type !== "thinking";
        const text = block?.redacted ? "内容已隐藏。" : (block?.thinking ?? "");
        // 只有内容变化才重新排版，计时刷新不重复解析 Markdown。
        if (view.source !== text) {
          view.source = text;
          updateAssistantMessage(view.text, text);
        }
        const following = view.text.scrollHeight - view.text.clientHeight - view.text.scrollTop < 24;
        if (following) view.text.scrollTop = view.text.scrollHeight;
      }
    };
    responses.push(current);
    message = current;
    return current;
  }

  // Pi 没有“最终回复”内容类型；后续响应出现时，将前一段说明归入过程。
  function placeInProcess(current) {
    const next = current.firstTool?.node;
    current.turn.body.insertBefore(current.body.parentElement, next?.parentElement === current.turn.body ? next : null);
  }

  function archiveResponse() {
    if (message?.body) placeInProcess(message);
  }

  function collapseProcess() {
    if (trace.body.contains(document.activeElement)) trace.summary.focus({ preventScroll: true });
    trace.node.open = false;
    for (const details of trace.body.querySelectorAll("details")) details.open = false;
  }

  function stopTiming() {
    endedAt ??= performance.now();
    clearInterval(timer);
    for (const current of responses) {
      current.endedAt ??= endedAt;
      for (const view of current.thinking.values()) view.endedAt ??= endedAt;
      dirty.add(current.renderTiming);
    }
    for (const call of new Set(calls.values())) {
      call.endedAt ??= endedAt;
      dirty.add(call.renderTiming);
    }
  }

  function skillLabel(skill) {
    if (!skill) return "";
    return ` · Skill ${skill.name} · ${skill.source === "read" ? "读取技能文件" : skill.source === "history" ? "技能展开记录" : "显式展开"}`;
  }

  function tool(id, name, owner = turn) {
    if (calls.has(id)) return calls.get(id);
    if (!owner) { startTurn(); owner = turn; }
    const view = disclosure(owner.body, "trace-tool");
    view.node.dataset.toolCallId = id;
    const args = element("pre", "trace-args");
    const result = element("pre", "trace-result");
    const meta = element("p", "trace-meta");
    const cardNode = element("div", "trace-card-slot");
    const raw = element("div", "trace-raw");
    // 自身内容与嵌套子调用分开存放，切换布局时不会移除子调用。
    const own = element("div", "trace-own");
    const nested = element("div", "trace-nested");
    raw.append(element("p", "trace-caption", "参数"), args, element("p", "trace-caption", "结果 / 最近一次进度"), result);
    for (const node of [args, result]) node.tabIndex = 0;
    own.append(meta, cardNode, raw);
    view.body.append(own, nested);
    // 有卡片时原始参数与结果收进折叠区；没有卡片时保持原来的直接展示。
    let rawDetails;
    let rawMode;
    function setRawMode(withCard) {
      const next = withCard ? "card" : "plain";
      if (rawMode === next) return;
      rawMode = next;
      if (withCard) {
        rawDetails ??= (() => {
          const node = element("details", "trace-raw");
          node.append(element("summary", "", "参数与原始结果"));
          return node;
        })();
        rawDetails.append(raw);
        own.replaceChildren(meta, cardNode, rawDetails);
      } else {
        own.replaceChildren(meta, cardNode, raw);
      }
    }
    const call = { ...view, nested, id, name, state: "等待执行", args: undefined, result: "", done: false };
    call.renderTiming = () => {
      const summary = view.summary;
      // 名称、目标、状态与耗时分开排版，目标过长时由 CSS 省略，不挤掉状态。
      summary.replaceChildren(summarySpan("trace-tool-name", call.name || "工具"));
      const detail = toolDetail(call.name, call.args);
      if (detail) {
        summary.append(document.createTextNode(" · "), summarySpan("trace-tool-detail", detail));
      }
      summary.append(document.createTextNode(" · "), summarySpan("trace-tool-state", call.state));
      const timing = call.durationMs !== undefined ? `${duration(call.durationMs)}（SDK）`
        : call.startedAt === undefined ? "" : `${duration((call.endedAt ?? performance.now()) - call.startedAt)}（界面计时）`;
      if (timing) summary.append(document.createTextNode(" · "), summarySpan("trace-tool-timing", timing));
      const stat = changeStat(call.name, call.args);
      // 失败和停止的行不展示差异统计，避免把未生效的修改读成结果。
      if (stat && call.state !== "执行失败") {
        summary.append(document.createTextNode(" "));
        if (stat.added) summary.append(summarySpan("trace-diff-added", `+${stat.added}`));
        if (stat.removed) summary.append(document.createTextNode(" "), summarySpan("trace-diff-removed", `-${stat.removed}`));
      }
      const skill = skillLabel(call.skill);
      if (skill) summary.append(summarySpan("trace-tool-skill", skill));
      view.node.dataset.state = call.state;
    };
    call.render = () => {
      call.renderTiming();
      const card = toolCard(call);
      // 卡片已经展示文件路径时不再重复；调用编号只保留在节点属性和悬停提示里。
      meta.textContent = [card ? "" : call.skill?.path, call.parent && `嵌套调用 ${call.parent}`].filter(Boolean).join("\n");
      meta.hidden = meta.textContent === "";
      meta.title = `toolCallId: ${call.id}${call.parent ? ` · parentToolCallId: ${call.parent}` : ""}`;
      args.textContent = preview(call.rawArgs ?? json(call.args));
      result.textContent = preview(call.result || (call.done ? "无文本结果" : "尚未返回结果"));
      cardNode.replaceChildren();
      cardNode.hidden = !card;
      if (card) cardNode.append(renderCard(call, card));
      setRawMode(Boolean(card));
    };
    calls.set(id, call);
    schedule(call.render);
    return call;
  }

  function syncBlocks(current) {
    current.blocks.forEach((block, index) => {
      if (block.type === "thinking" && !current.thinking.has(index)) {
        const view = disclosure(current.turn.body, "trace-thinking");
        view.node.open = !historical && !block.redacted;
        // 思考正文与回复一样经过 Markdown 清理链路，不使用 pre 展示原始标记。
        view.text = element("div", "trace-thinking-body");
        view.text.tabIndex = 0;
        view.body.append(view.text);
        current.thinking.set(index, view);
      }
      if (block.type === "toolCall") {
        const call = tool(block.id, block.name, current.turn);
        current.firstTool ??= call;
        call.args = block.arguments;
        if (block.argumentsError && !call.done) call.result = block.argumentsError;
        call.rawArgs = undefined;
        schedule(call.render);
      }
    });
    schedule(current.render);
  }

  function finalMessage(info, completed = true) {
    const current = ensureMessage();
    // message_end 是最终权威快照；替换增量累积，不能再追加一次正文。
    current.blocks = info.content;
    current.info = info;
    current.hasToolCalls = info.content.some(block => block.type === "toolCall");
    current.completed = completed;
    if (completed) {
      current.endedAt ??= performance.now();
      for (const view of current.thinking.values()) view.endedAt ??= current.endedAt;
    }
    syncBlocks(current);
  }

  function execution(event) {
    const call = tool(event.toolCallId, event.toolName);
    call.name = event.toolName;
    if (event.args !== undefined) { call.args = event.args; call.rawArgs = undefined; }
    call.skill = event.skill ?? call.skill;
    call.parent = event.parentToolCallId ?? call.parent;
    if (!historical && event.type !== "tool_execution_end") call.startedAt ??= performance.now();
    if (call.parent && calls.has(call.parent)) calls.get(call.parent).nested.append(call.node);
    if (event.result) {
      call.result = textContent(event.result.content);
      call.exitCode = event.result.exitCode;
      call.diff = event.result.diff;
      call.fullOutputPath = event.result.fullOutputPath;
    }
    if (event.type === "tool_execution_end") {
      call.done = true;
      call.state = event.isError ? "执行失败" : "执行完成";
      call.durationMs = event.durationMs;
      call.endedAt ??= performance.now();
    } else call.state = event.type === "tool_execution_update" ? "执行中 · 进度更新" : "执行中";
    schedule(call.render);
  }

  function accept(event) {
    if (finished || disposed) return;
    if (event.type === "agent_start") { phase = "等待模型响应"; lifecycle(event.type, "开始运行"); }
    if (event.type === "turn_start") { phase = "等待模型响应"; startTurn(); }
    if (event.type === "message_start" && event.message.role === "assistant") {
      archiveResponse();
      message = undefined;
      finalMessage(event.message, false);
    }
    if (event.type === "message_end") {
      if (event.message.role === "assistant") finalMessage(event.message);
      if (event.message.skill) {
        lifecycle("skill", `${event.message.skill.name} · ${event.message.skill.source === "history" ? "技能展开记录" : "显式展开"} · ${event.message.skill.path}`);
      }
    }
    if (event.type === "message_update") {
      const current = ensureMessage(), delta = event.assistantMessageEvent;
      const index = delta.contentIndex;
      if (delta.type.startsWith("text_") || delta.type.startsWith("thinking_")) {
        const kind = delta.type.startsWith("text_") ? "text" : "thinking";
        phase = kind === "thinking" ? (delta.type === "thinking_end" ? "等待模型继续" : "模型正在思考") : "正在生成回复";
        const block = current.blocks[index] ?? { type: kind, [kind]: "" };
        if (delta.redacted) { block.redacted = true; block[kind] = ""; }
        else if (!block.redacted) {
          if (delta.type.endsWith("_delta")) block[kind] += delta.delta;
          if (delta.type.endsWith("_end")) block[kind] = delta.content;
        }
        current.blocks[index] = block;
        syncBlocks(current);
        if (kind === "thinking") {
          const view = current.thinking.get(index);
          if (delta.type !== "thinking_end") view.startedAt ??= performance.now();
          else if (view.startedAt !== undefined) view.endedAt ??= performance.now();
        }
      } else if (delta.type.startsWith("toolcall_")) {
        phase = "正在生成工具参数";
        current.hasToolCalls = true;
        archiveResponse();
        const key = `pending:${current.serial}:${index}`;
        let call = calls.get(key);
        if (!call) { call = tool(delta.id ?? delta.toolCall?.id ?? key, delta.toolName ?? delta.toolCall?.name); calls.set(key, call); }
        current.firstTool ??= call;
        if (delta.type === "toolcall_delta") { call.state = "参数生成中"; call.rawArgs = (call.rawArgs ?? "") + delta.delta; }
        if (delta.type === "toolcall_end") {
          call.id = delta.toolCall.id; call.name = delta.toolCall.name; call.args = delta.toolCall.arguments;
          call.node.dataset.toolCallId = call.id;
          call.rawArgs = undefined; call.state = "等待执行";
          calls.set(call.id, call);
          current.blocks[index] = delta.toolCall;
        }
        schedule(call.render);
      }
    }
    if (event.type.startsWith("tool_execution_")) execution(event);
    if (event.type === "turn_end") {
      if (event.message) finalMessage(event.message);
      if (turn) { turn.state = "已结束 · turn_end"; schedule(turn.render); }
    }
    if (event.type === "agent_end") {
      phase = event.willRetry ? "等待自动重试" : "正在收尾";
      lifecycle(event.type, event.willRetry ? "本次运行结束，等待自动重试" : "本次运行结束，等待收尾");
    }
    if (event.type === "agent_settled") {
      settled = true;
      state = event.aborted ? "已停止" : "处理已结束";
      lifecycle(event.type, event.aborted ? "已停止" : "无后续自动处理");
      stopTiming();
      collapseProcess();
    }
    if (["auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"].includes(event.type)) {
      const label = { auto_retry_start: "自动重试", auto_retry_end: "重试结束", compaction_start: "整理上下文", compaction_end: "整理结束" }[event.type];
      phase = label;
      lifecycle(event.type, `${label}${event.attempt === undefined ? "" : ` ${event.attempt}${event.maxAttempts === undefined ? "" : `/${event.maxAttempts}`}`}${event.success === false || event.failed ? " · 未成功" : ""}${event.aborted ? " · 已停止" : ""}`);
    }
    schedule();
  }

  function restore(output) {
    if (output.role === "assistant") { startTurn(); finalMessage(output); }
    if (output.role === "toolResult") {
      execution({ type: "tool_execution_end", toolCallId: output.toolCallId, toolName: output.toolName,
        result: { content: output.content, exitCode: output.exitCode, diff: output.diff, fullOutputPath: output.fullOutputPath },
        isError: output.isError, durationMs: output.durationMs, skill: output.skill });
      for (const nested of output.nestedCalls?.calls ?? []) {
        const call = tool(nested.id, nested.name);
        call.parent = output.toolCallId; call.args = nested.arguments; call.done = nested.status !== "unfinished";
        call.state = { ok: "执行完成", error: "执行失败", unfinished: "结果未确认" }[nested.status];
        call.result = nested.error || "历史仅保存嵌套调用摘要，未记录结果正文。";
        call.durationMs = nested.durationMs;
        calls.get(output.toolCallId).nested.append(call.node);
        schedule(call.render);
      }
      if (output.nestedCalls?.complete === false) lifecycle("nestedCalls", "嵌套调用记录不完整");
    }
  }

  function finish({ outcome, stopped } = {}) {
    if (finished || disposed) return;
    finished = true;
    if (!historical && outcome === "unconfirmed") state = "请求结果未确认";
    else if (!historical && !settled) state = stopped ? "已停止 · 未收到收尾事件" : "请求已返回 · 未收到收尾事件";
    stopTiming();
    collapseProcess();
    for (const call of new Set(calls.values())) {
      if (!call.done) { call.state = "结果未确认"; dirty.add(call.render); }
    }
    for (const current of turns) {
      if (!historical && current.state === "进行中") { current.state = "未收到 turn_end"; dirty.add(current.render); }
    }
    if (frame !== undefined) cancelAnimationFrame(frame);
    flush();
    dispose();
  }

  if (!historical) timer = setInterval(() => {
    renderSummary();
    for (const current of responses) current.renderTiming();
    for (const call of new Set(calls.values())) call.renderTiming();
  }, 250);
  function dispose() {
    disposed = true;
    clearInterval(timer);
    if (frame !== undefined) cancelAnimationFrame(frame);
    window.removeEventListener("pagehide", dispose);
  }
  // 页面销毁也清理计时；正常完成后不保留页面生命周期监听。
  if (!historical) window.addEventListener("pagehide", dispose, { once: true });
  schedule();
  return { accept, restore, finish, dispose, root };
}

export function appendOutputHistory(container, history, onUpdate = () => {}) {
  let trace;
  for (const item of history) {
    if (item.role === "user" || (!item.output && !item.skill)) {
      trace?.finish(); trace = undefined;
      appendMessage(container, item.role, item.text);
    }
    if (item.output || item.skill) {
      trace ??= createOutputTrace(container, { historical: true, onUpdate });
      if (item.skill) trace.accept({ type: "message_end", message: { role: "user", skill: item.skill } });
      if (item.output) trace.restore(item.output);
    }
  }
  trace?.finish();
}
