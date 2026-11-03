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

export function createOutputTrace(container, { historical = false, onUpdate = () => {} } = {}) {
  const root = element("section", "output-run");
  container.append(root);
  const trace = disclosure(root, "output-trace");
  const turns = [], calls = new Map(), dirty = new Set();
  let turn, message, frame, messageSerial = 0, finished = false, settled = false;
  let state = historical ? "历史恢复" : "处理中";

  function flush() {
    frame = undefined;
    trace.summary.textContent = `Trace · ${turns.length} ${historical ? "条响应记录" : "turn"} · ${state}`;
    for (const render of dirty) render();
    dirty.clear();
    onUpdate();
  }

  function schedule(render) {
    if (render) dirty.add(render);
    if (frame === undefined) frame = requestAnimationFrame(flush);
  }

  function lifecycle(type, label) {
    trace.body.append(element("p", "trace-event", `${type} · ${label}`));
  }

  function startTurn() {
    const view = disclosure(trace.body, "trace-turn");
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
    const current = { blocks: [], thinking: new Map(), turn, body: null, serial: ++messageSerial };
    const meta = element("p", "trace-meta");
    turn.body.append(meta);
    current.render = () => {
      const text = textContent(current.blocks);
      if (text && !current.body) current.body = appendMessage(root, "assistant", "");
      if (current.body) {
        current.body.parentElement.hidden = !text;
        updateAssistantMessage(current.body, text);
      }
      const info = current.info ?? {};
      meta.textContent = [info.provider && `${info.provider}/${info.model}`, info.stopReason && `stopReason: ${info.stopReason}`,
        info.durationMs !== undefined && `${info.durationMs} ms`,
        info.usage && `tokens: ${info.usage.totalTokens ?? "未知"}（输入 ${info.usage.input ?? "未知"} / 输出 ${info.usage.output ?? "未知"}）`,
        info.errorMessage].filter(Boolean).join(" · ");
      for (const [index, view] of current.thinking) {
        const block = current.blocks[index];
        view.node.hidden = block?.type !== "thinking";
        view.summary.textContent = block?.redacted ? "Thinking · 供应商未公开内容" : "Thinking · 模型返回的思考";
        view.text.textContent = block?.redacted ? "内容已隐藏。" : (block?.thinking ?? "");
      }
    };
    message = current;
    return current;
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
    for (const node of [args, result]) node.tabIndex = 0;
    view.body.append(meta, element("p", "trace-caption", "参数"), args, element("p", "trace-caption", "结果 / 最近一次进度"), result);
    const call = { ...view, id, name, state: "等待执行", args: undefined, result: "", done: false };
    call.render = () => {
      view.summary.textContent = `${call.name || "工具"} · ${call.state}${call.durationMs === undefined ? "" : ` · ${call.durationMs} ms`}${skillLabel(call.skill)}`;
      view.node.dataset.state = call.state;
      meta.textContent = [`toolCallId: ${call.id}`, call.parent && `parentToolCallId: ${call.parent}`, call.skill?.path].filter(Boolean).join("\n");
      args.textContent = preview(call.rawArgs ?? json(call.args));
      result.textContent = preview(call.result || (call.done ? "无文本结果" : "尚未返回结果"));
    };
    calls.set(id, call);
    schedule(call.render);
    return call;
  }

  function syncBlocks(current) {
    current.blocks.forEach((block, index) => {
      if (block.type === "thinking" && !current.thinking.has(index)) {
        const view = disclosure(current.turn.body, "trace-thinking");
        view.text = element("pre", "");
        view.text.tabIndex = 0;
        view.body.append(view.text);
        current.thinking.set(index, view);
      }
      if (block.type === "toolCall") {
        const call = tool(block.id, block.name, current.turn);
        call.args = block.arguments;
        if (block.argumentsError && !call.done) call.result = block.argumentsError;
        call.rawArgs = undefined;
        schedule(call.render);
      }
    });
    schedule(current.render);
  }

  function finalMessage(info) {
    const current = ensureMessage();
    // message_end 是最终权威快照；替换增量累积，不能再追加一次正文。
    current.blocks = info.content;
    current.info = info;
    syncBlocks(current);
  }

  function execution(event) {
    const call = tool(event.toolCallId, event.toolName);
    call.name = event.toolName;
    if (event.args !== undefined) { call.args = event.args; call.rawArgs = undefined; }
    call.skill = event.skill ?? call.skill;
    call.parent = event.parentToolCallId ?? call.parent;
    if (call.parent && calls.has(call.parent)) calls.get(call.parent).body.append(call.node);
    if (event.result) call.result = textContent(event.result.content);
    if (event.type === "tool_execution_end") {
      call.done = true;
      call.state = event.isError ? "执行失败" : "执行完成";
      call.durationMs = event.durationMs;
    } else call.state = event.type === "tool_execution_update" ? "执行中 · 进度更新" : "执行中";
    schedule(call.render);
  }

  function accept(event) {
    if (finished) return;
    if (event.type === "agent_start") lifecycle(event.type, "开始运行");
    if (event.type === "turn_start") startTurn();
    if (event.type === "message_start" && event.message.role === "assistant") {
      message = undefined;
      finalMessage(event.message);
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
        const block = current.blocks[index] ?? { type: kind, [kind]: "" };
        if (delta.redacted) { block.redacted = true; block[kind] = ""; }
        else if (!block.redacted) {
          if (delta.type.endsWith("_delta")) block[kind] += delta.delta;
          if (delta.type.endsWith("_end")) block[kind] = delta.content;
        }
        current.blocks[index] = block;
        syncBlocks(current);
      } else if (delta.type.startsWith("toolcall_")) {
        const key = `pending:${current.serial}:${index}`;
        let call = calls.get(key);
        if (!call) { call = tool(delta.id ?? delta.toolCall?.id ?? key, delta.toolName ?? delta.toolCall?.name); calls.set(key, call); }
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
    if (event.type === "agent_end") lifecycle(event.type, event.willRetry ? "本次运行结束，等待自动重试" : "本次运行结束，等待收尾");
    if (event.type === "agent_settled") {
      settled = true;
      state = event.aborted ? "已停止 · agent_settled" : "已收尾 · agent_settled";
      lifecycle(event.type, event.aborted ? "已停止" : "无后续自动处理");
    }
    if (["auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"].includes(event.type)) {
      const label = { auto_retry_start: "自动重试", auto_retry_end: "重试结束", compaction_start: "整理上下文", compaction_end: "整理结束" }[event.type];
      lifecycle(event.type, `${label}${event.attempt === undefined ? "" : ` ${event.attempt}${event.maxAttempts === undefined ? "" : `/${event.maxAttempts}`}`}${event.success === false || event.failed ? " · 未成功" : ""}${event.aborted ? " · 已停止" : ""}`);
    }
    schedule();
  }

  function restore(output) {
    if (output.role === "assistant") { startTurn(); finalMessage(output); }
    if (output.role === "toolResult") {
      execution({ type: "tool_execution_end", toolCallId: output.toolCallId, toolName: output.toolName,
        result: { content: output.content }, isError: output.isError, durationMs: output.durationMs, skill: output.skill });
      for (const nested of output.nestedCalls?.calls ?? []) {
        const call = tool(nested.id, nested.name);
        call.parent = output.toolCallId; call.args = nested.arguments; call.done = nested.status !== "unfinished";
        call.state = { ok: "执行完成", error: "执行失败", unfinished: "结果未确认" }[nested.status];
        call.result = nested.error || "历史仅保存嵌套调用摘要，未记录结果正文。";
        call.durationMs = nested.durationMs;
        calls.get(output.toolCallId).body.append(call.node);
        schedule(call.render);
      }
      if (output.nestedCalls?.complete === false) lifecycle("nestedCalls", "嵌套调用记录不完整");
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    if (!historical && !settled) state = "请求已返回 · 未收到 agent_settled";
    for (const call of new Set(calls.values())) {
      if (!call.done) { call.state = "结果未确认"; dirty.add(call.render); }
    }
    for (const current of turns) {
      if (!historical && current.state === "进行中") { current.state = "未收到 turn_end"; dirty.add(current.render); }
    }
    if (frame !== undefined) cancelAnimationFrame(frame);
    flush();
  }

  schedule();
  return { accept, restore, finish, root };
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
