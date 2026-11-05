// 运行轨迹的页面投影：把实时输出事件与历史消息整理成按轮次组织的记录。
// 只读展示数据，不参与发送、工具执行或 Pi 历史保存。

function textOf(content) {
  if (typeof content === "string") return content;
  return (content ?? [])
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
}

function thinkingOf(content) {
  return (content ?? [])
    .filter((block) => block.type === "thinking" && !block.redacted)
    .map((block) => block.thinking)
    .join("\n\n");
}

function usageOf(output) {
  const usage = output?.usage;
  if (!usage || typeof usage !== "object") return null;
  const input = Number(usage.input) || 0;
  const outputTokens = Number(usage.output) || 0;
  const total = Number(usage.totalTokens);
  return {
    input,
    output: outputTokens,
    total: Number.isFinite(total) ? total : input + outputTokens,
  };
}

function recordId(serial) {
  return `trajectory-${serial}`;
}

export function createTrajectoryModel() {
  let sessionId = "";
  let requests = [];
  let active = null;
  let serial = 0;
  const activeTools = new Map();

  function addRecord(request, record) {
    const value = {
      ...record,
      id: recordId(++serial),
      requestIndex: request.index,
    };
    request.records.push(value);
    if (value.usage) {
      request.usage.input += value.usage.input;
      request.usage.output += value.usage.output;
      request.usage.total += value.usage.total;
    }
    if (!Number.isFinite(request.startedAt) && Number.isFinite(value.ts)) {
      request.startedAt = value.ts;
    }
    if (Number.isFinite(value.ts) && Number.isFinite(value.durationMs)) {
      request.endedAt = Math.max(request.endedAt ?? 0, value.ts + value.durationMs);
    } else if (Number.isFinite(value.ts)) {
      request.endedAt = Math.max(request.endedAt ?? 0, value.ts);
    }
    return value;
  }

  function markRunningTools(active, status, clear = true) {
    for (const record of active?.records ?? []) {
      if (record.kind === "tool" && record.status === "running") record.status = status;
    }
    // 收尾后保留映射，迟到的 tool_execution_end 仍能补回同一条记录；下一轮开始时再清空。
    if (clear) activeTools.clear();
  }

  function startRequest(text, ts) {
    const at = Number.isFinite(ts) ? ts : null;
    if (active) {
      markRunningTools(active, "unfinished", true);
      active.endedAt = active.endedAt ?? at;
      active.status = "done";
    }
    const request = {
      index: requests.length,
      userText: typeof text === "string" ? text : "",
      startedAt: at,
      endedAt: null,
      records: [],
      usage: { input: 0, output: 0, total: 0 },
      status: "live",
      source: "live",
      retryMs: 0,
      retryCount: 0,
      compactionMs: 0,
      compactionStartedAt: null,
    };
    requests.push(request);
    active = request;
    return request;
  }

  function ensureRequest(ts) {
    if (active && active.status === "live") {
      if (!Number.isFinite(active.startedAt) && Number.isFinite(ts)) active.startedAt = ts;
      return active;
    }
    return startRequest("", ts);
  }

  function closeActive(ts = Date.now()) {
    if (!active) return;
    markRunningTools(active, "unfinished", false);
    active.endedAt = active.endedAt ?? ts;
    active.status = "done";
    active = null;
  }

  function addUser(text, ts) {
    const request = active ?? startRequest(text, ts);
    addRecord(request, { kind: "user", text, ts, durationMs: 0 });
  }

  function addAssistant(output, fallbackTs) {
    const durationMs = Number.isFinite(output?.durationMs) ? output.durationMs : undefined;
    const ts = Number.isFinite(output?.ts)
      ? output.ts
      : (Number.isFinite(fallbackTs) ? fallbackTs - (durationMs ?? 0) : null);
    const request = ensureRequest(ts);
    const content = output?.content ?? [];
    const toolCalls = content.filter((block) => block.type === "toolCall");
    return addRecord(request, {
      kind: "assistant",
      text: textOf(content),
      thinking: thinkingOf(content),
      toolCalls: toolCalls.map((block) => ({ id: block.id, name: block.name, arguments: block.arguments })),
      usage: usageOf(output),
      model: output?.model,
      provider: output?.provider,
      stopReason: output?.stopReason,
      errorMessage: output?.errorMessage,
      ts,
      durationMs,
    });
  }

  function addTool(output, live = false) {
    const durationMs = Number.isFinite(output?.durationMs) ? output.durationMs : undefined;
    const ts = Number.isFinite(output?.ts)
      ? output.ts
      : (live ? Date.now() - (durationMs ?? 0) : null);
    const request = ensureRequest(ts);
    return addRecord(request, {
      kind: "tool",
      toolName: output?.toolName ?? "tool",
      args: output?.args,
      result: textOf(output?.result?.content ?? output?.content),
      isError: output?.isError === true,
      skill: output?.skill,
      parentToolCallId: output?.parentToolCallId,
      nestedCalls: output?.nestedCalls,
      status: "done",
      summaryFile: typeof output?.summaryFile === "string"
        ? output.summaryFile
        : (typeof output?.result?.summaryFile === "string" ? output.result.summaryFile : undefined),
      ts,
      durationMs,
    });
  }

  function startTool(output) {
    const ts = Number.isFinite(output?.ts) ? output.ts : Date.now();
    const request = ensureRequest(ts);
    const record = addRecord(request, {
      kind: "tool",
      toolName: output?.toolName ?? "tool",
      args: output?.args,
      result: "",
      isError: false,
      skill: output?.skill,
      parentToolCallId: output?.parentToolCallId,
      status: "running",
      ts,
      durationMs: undefined,
    });
    activeTools.set(output.toolCallId, record);
  }

  function endTool(output) {
    const existing = activeTools.get(output.toolCallId);
    if (!existing) {
      addTool(output, true);
      return;
    }
    activeTools.delete(output.toolCallId);
    existing.result = textOf(output?.result?.content ?? output?.content);
    existing.isError = output?.isError === true;
    existing.durationMs = Number.isFinite(output?.durationMs) ? output.durationMs : undefined;
    existing.nestedCalls = output?.nestedCalls;
    existing.summaryFile = typeof output?.summaryFile === "string"
      ? output.summaryFile
      : (typeof output?.result?.summaryFile === "string" ? output.result.summaryFile : existing.summaryFile);
    existing.status = "done";
    const request = requests[existing.requestIndex];
    if (request) {
      const end = existing.ts + (existing.durationMs ?? 0);
      if (Number.isFinite(end)) request.endedAt = Math.max(request.endedAt ?? 0, end);
    }
  }

  function addStatus(text, ts) {
    const request = ensureRequest(ts);
    addRecord(request, { kind: "status", text, ts, durationMs: 0 });
  }

  function accept(output) {
    if (!output || typeof output !== "object") return;
    if (output.type === "agent_start") {
      ensureRequest(output.ts);
      return;
    }
    if (output.type === "message_end" && output.message?.role === "assistant") {
      addAssistant(output.message, output.ts ?? Date.now());
      return;
    }
    if (output.type === "tool_execution_start") {
      startTool(output);
      return;
    }
    if (output.type === "tool_execution_end") {
      endTool(output);
      return;
    }
    if (output.type === "steer_delivered") {
      addUser(output.text, output.ts ?? Date.now());
      return;
    }
    if (output.type === "auto_retry_start") {
      const ts = output.ts ?? Date.now();
      const request = ensureRequest(ts);
      request.retryMs += Number.isFinite(output.delayMs) ? output.delayMs : 0;
      request.retryCount += 1;
      addStatus(`模型重试：第 ${output.attempt ?? 1} 次`, ts);
      return;
    }
    if (output.type === "compaction_start") {
      const ts = output.ts ?? Date.now();
      const request = ensureRequest(ts);
      request.compactionStartedAt = ts;
      addStatus("开始整理上下文", ts);
      return;
    }
    if (output.type === "compaction_end") {
      const ts = output.ts ?? Date.now();
      const request = ensureRequest(ts);
      if (Number.isFinite(request.compactionStartedAt)) {
        request.compactionMs += Math.max(0, ts - request.compactionStartedAt);
        request.compactionStartedAt = null;
      }
      addStatus(output.aborted ? "上下文整理已取消" : "上下文整理完成", ts);
      return;
    }
    if (output.type === "agent_settled") {
      closeActive(output.ts ?? Date.now());
    }
  }

  function beginRequest(text) {
    const at = Date.now();
    const request = startRequest(text, at);
    addRecord(request, { kind: "user", text: text ?? "", ts: at, durationMs: 0 });
    return request;
  }

  function endRequest() {
    closeActive(Date.now());
  }

  function loadFromHistory(history, nextSessionId = "") {
    sessionId = typeof nextSessionId === "string" ? nextSessionId : "";
    requests = [];
    active = null;
    serial = 0;
    activeTools.clear();
    const callArgs = new Map();
    const pendingCalls = new Map();

    for (const item of Array.isArray(history) ? history : []) {
      if (!item || typeof item !== "object") continue;
      if (item.role === "user") {
        const request = startRequest(item.text ?? "", item.ts);
        addRecord(request, { kind: "user", text: item.text ?? "", ts: item.ts, durationMs: 0 });
        continue;
      }
      if (item.role === "assistant" && item.output) {
        const output = item.output;
        const request = ensureRequest(output.ts);
        for (const block of output.content ?? []) {
          if (block.type === "toolCall" && block.id) {
            callArgs.set(block.id, block.arguments);
            pendingCalls.set(block.id, {
              request,
              name: block.name,
              args: block.arguments,
              ts: Number.isFinite(block.ts) ? block.ts : output.ts,
            });
          }
        }
        addAssistant(output, output.ts);
        continue;
      }
      if (item.role === "tool" && item.output) {
        const output = item.output;
        pendingCalls.delete(output.toolCallId);
        addTool({ ...output, args: output.args ?? callArgs.get(output.toolCallId) });
        continue;
      }
      if (item.role === "status") {
        addStatus(item.text ?? "", item.ts);
      }
    }

    // 历史结束时仍未返回结果的工具调用标记为未确认，与实时停止的呈现一致。
    for (const call of pendingCalls.values()) {
      if (!call.request) continue;
      addRecord(call.request, {
        kind: "tool",
        toolName: call.name,
        args: call.args,
        result: "",
        isError: false,
        status: "unfinished",
        ts: call.ts,
        durationMs: undefined,
      });
    }

    for (const request of requests) {
      request.source = "history";
      request.status = "done";
      request.startedAt = request.startedAt
        ?? request.records.find((record) => Number.isFinite(record.ts))?.ts
        ?? null;
      request.endedAt = request.endedAt
        ?? [...request.records].reverse().find((record) => Number.isFinite(record.ts))?.ts
        ?? null;
    }
    active = null;
  }

  function isReplayRecord(record) {
    if (record.kind !== "tool") return false;
    if (typeof record.summaryFile === "string" && record.summaryFile !== "") return true;
    const command = record.args?.command;
    return typeof command === "string" && /(?:^|[\s/])(?:execute\.cjs|playwright\s+test)(?:\s|$)/.test(command);
  }

  function timingOf(request) {
    let modelMs = 0;
    let toolMs = 0;
    let replayMs = 0;
    let toolErrorMs = 0;
    for (const record of request.records) {
      const duration = Number.isFinite(record.durationMs) ? Math.max(0, record.durationMs) : 0;
      if (record.kind === "assistant") modelMs += duration;
      else if (record.kind === "tool") {
        toolMs += duration;
        if (isReplayRecord(record)) replayMs += duration;
        if (record.isError) toolErrorMs += duration;
      }
    }
    const retryMs = Number.isFinite(request.retryMs) ? Math.max(0, request.retryMs) : 0;
    const compactionMs = Number.isFinite(request.compactionMs) ? Math.max(0, request.compactionMs) : 0;
    const hasWindow = Number.isFinite(request.startedAt) && Number.isFinite(request.endedAt) && request.endedAt > request.startedAt;
    const known = modelMs + toolMs + retryMs + compactionMs;
    const totalMs = hasWindow ? Math.max(request.endedAt - request.startedAt, 0) : known;
    const waitingMs = hasWindow ? Math.max(0, totalMs - known) : 0;
    return {
      totalMs,
      waitingMs,
      modelMs,
      toolMs,
      replayMs,
      toolOtherMs: Math.max(0, toolMs - replayMs),
      toolErrorMs,
      retryMs,
      retryCount: request.retryCount ?? 0,
      compactionMs,
      source: request.source === "history" ? "history" : "live",
      available: hasWindow || known > 0,
    };
  }

  function snapshot() {
    const totals = { requests: requests.length, durationMs: 0, input: 0, output: 0, total: 0 };
    for (const request of requests) {
      totals.input += request.usage.input;
      totals.output += request.usage.output;
      totals.total += request.usage.total;
      if (Number.isFinite(request.startedAt) && Number.isFinite(request.endedAt)) {
        totals.durationMs += Math.max(0, request.endedAt - request.startedAt);
      }
    }
    const records = requests.flatMap((request) => request.records);
    return {
      sessionId,
      requests: requests.map((request) => ({
        ...request,
        timing: timingOf(request),
        records: request.records.map((record) => ({ ...record })),
      })),
      hasTimeline: records.some((record) => Number.isFinite(record.ts)),
      totals,
    };
  }

  function reset(nextSessionId = "") {
    sessionId = typeof nextSessionId === "string" ? nextSessionId : "";
    requests = [];
    active = null;
    activeTools.clear();
  }

  return {
    accept,
    beginRequest,
    endRequest,
    loadHistory: loadFromHistory,
    reset,
    snapshot,
  };
}
