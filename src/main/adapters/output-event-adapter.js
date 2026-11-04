const path = require("node:path");

// 只投影界面需要的字段，不透传完整 SDK 对象、签名、图片正文或供应商请求。
function contentBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  return (content ?? []).flatMap(block => {
    if (block.type === "text") return [{ type: "text", text: block.text }];
    if (block.type === "thinking") return [{
      type: "thinking", thinking: block.redacted ? "" : block.thinking, redacted: block.redacted === true,
    }];
    if (block.type === "toolCall") return [{
      type: "toolCall", id: block.id, name: block.name, arguments: block.arguments,
      argumentsError: block.argumentsError,
    }];
    if (block.type === "image") return [{ type: "text", text: "[图片内容]" }];
    return [];
  });
}

// 工具结果里只取渲染卡片需要的标量字段，避免把 details/structuredContent 整体送到页面。
function toolResultExtras(details, structured) {
  const extras = {};
  if (details && typeof details === "object") {
    if (typeof details.diff === "string") extras.diff = details.diff;
    if (typeof details.fullOutputPath === "string") extras.fullOutputPath = details.fullOutputPath;
    // 任务清单只保留可识别的条目标题与状态，页面不接收其他 details 内容。
    if (Array.isArray(details.todos)) {
      extras.todos = details.todos
        .filter(todo => todo && typeof todo.content === "string"
          && ["pending", "in_progress", "completed"].includes(todo.status))
        .map(todo => ({ content: todo.content, status: todo.status }));
    }
  }
  if (structured && typeof structured === "object") {
    if (Number.isInteger(structured.exit_code)) extras.exitCode = structured.exit_code;
    if (extras.fullOutputPath === undefined && typeof structured.full_output_path === "string") {
      extras.fullOutputPath = structured.full_output_path;
    }
  }
  return extras;
}

function outputMessage(message) {
  if (!message) return null;
  if (message.role === "assistant") return {
    role: "assistant", content: contentBlocks(message.content),
    provider: message.provider, model: message.model, usage: message.usage,
    stopReason: message.stopReason, errorMessage: message.errorMessage, durationMs: message.durationMs,
  };
  if (message.role === "toolResult") return {
    role: "toolResult", toolCallId: message.toolCallId, toolName: message.toolName,
    content: contentBlocks(message.content), isError: message.isError,
    // 历史消息只保存 details；bash 的退出码在旧记录里只能从结果文本读取。
    ...toolResultExtras(message.details, undefined),
    durationMs: message.durationMs, nestedCalls: message.nestedCalls && {
      complete: message.nestedCalls.complete,
      calls: message.nestedCalls.calls.map(call => ({
        id: call.id, name: call.name, arguments: call.arguments,
        argumentsBytes: call.argumentsBytes, status: call.status,
        durationMs: call.durationMs, error: call.error,
      })),
    },
  };
  return null;
}

function skillForRead(toolName, args, skills = [], cwd = process.cwd()) {
  if (toolName !== "read" || typeof args?.path !== "string") return undefined;
  const target = path.resolve(cwd, args.path);
  const skill = skills.find(item => path.resolve(cwd, item.filePath) === target);
  return skill ? { name: skill.name, path: skill.filePath, source: "read" } : undefined;
}

function createOutputEventAdapter(getSession, parseSkillBlock, input) {
  const requestedSkill = input.match(/^\/skill:([^\s]+)(?:\s|$)/)?.[1];
  const calls = new Map();
  // 追踪生成中插话的排队与投递：Pi 在投递前先发 queue_update 移除条目。
  const steering = new Set();
  const delivered = new Set();
  return event => {
    const session = getSession();
    const skills = session.resourceLoader?.getSkills?.().skills ?? [];
    const cwd = session.sessionManager?.getCwd?.();
    if (["agent_start", "turn_start"].includes(event.type)) return { type: event.type };
    if (event.type === "agent_end") return { type: event.type, willRetry: event.willRetry === true };
    if (event.type === "agent_settled") return { type: event.type, aborted: event.aborted };
    if (event.type === "turn_end") return {
      type: event.type, message: outputMessage(event.message),
      toolResults: (event.toolResults ?? []).map(outputMessage),
    };
    if (event.type === "queue_update") {
      const next = new Set((event.steering ?? []).map(String));
      for (const text of steering) if (!next.has(text)) delivered.add(text);
      steering.clear();
      for (const text of next) steering.add(text);
      return { type: "queue_update", steering: [...next] };
    }
    if (event.type === "message_start" && event.message?.role === "user") {
      const text = typeof event.message.content === "string"
        ? event.message.content
        : (event.message.content ?? []).filter(block => block.type === "text").map(block => block.text).join("");
      // 普通用户消息由页面本地回显，只有投递的插话需要补一条消息。
      if (text !== "" && delivered.delete(text)) return { type: "steer_delivered", text };
      return null;
    }
    if (["message_start", "message_end"].includes(event.type)) {
      if (event.message.role === "user" && event.type === "message_end" && requestedSkill) {
        const text = typeof event.message.content === "string" ? event.message.content
          : (event.message.content ?? []).filter(item => item.type === "text").map(item => item.text).join("");
        const expanded = parseSkillBlock(text);
        if (expanded?.name === requestedSkill && skills.some(skill => skill.name === expanded.name && skill.filePath === expanded.location)) {
          return { type: event.type, message: { role: "user", skill: {
            name: expanded.name, path: expanded.location, source: "explicit",
          } } };
        }
      }
      // toolResult 已由执行生命周期展示；避免再绘制一份相同结果。
      return event.message.role === "assistant" ? { type: event.type, message: outputMessage(event.message) } : null;
    }
    if (event.type === "message_update") {
      const update = event.assistantMessageEvent;
      const delta = { type: update.type, contentIndex: update.contentIndex };
      if (!["text_start", "text_delta", "text_end", "thinking_start", "thinking_delta", "thinking_end", "toolcall_start", "toolcall_delta", "toolcall_end"].includes(delta.type)) return null;
      if (delta.type === "toolcall_start") {
        const call = update.partial?.content[update.contentIndex];
        delta.id = call?.id;
        delta.toolName = call?.name;
      }
      if (delta.type === "toolcall_end") {
        delta.toolCall = contentBlocks([update.toolCall])[0];
      }
      if (delta.type.endsWith("_delta")) delta.delta = update.delta;
      if (delta.type === "text_end" || delta.type === "thinking_end") delta.content = update.content;
      // 安全过滤不公开的 reasoning；只展示供应商实际给出的可见 thinking。
      if (delta.type.startsWith("thinking_") && update.partial?.content[update.contentIndex]?.redacted) {
        return { type: event.type, assistantMessageEvent: { type: delta.type, contentIndex: delta.contentIndex, redacted: true } };
      }
      return { type: event.type, usage: event.message?.usage, assistantMessageEvent: delta };
    }
    if (event.type.startsWith("tool_execution_")) {
      const skill = skillForRead(event.toolName, event.args, skills, cwd);
      if (event.type === "tool_execution_start") calls.set(event.toolCallId, skill);
      const result = event.type === "tool_execution_update" ? event.partialResult : event.result;
      const projected = {
        type: event.type, toolCallId: event.toolCallId, toolName: event.toolName,
        parentToolCallId: event.parentToolCallId, args: event.args,
        skill: skill ?? calls.get(event.toolCallId),
      };
      if (result) projected.result = {
        content: contentBlocks(result.content),
        ...toolResultExtras(result.details, result.structuredContent),
      };
      if (event.type === "tool_execution_end") {
        projected.isError = event.isError;
        projected.durationMs = event.durationMs;
        calls.delete(event.toolCallId);
      }
      return projected;
    }
    if (["auto_retry_start", "auto_retry_end", "compaction_start", "compaction_end"].includes(event.type)) {
      return { type: event.type, attempt: event.attempt, maxAttempts: event.maxAttempts,
        reason: event.reason, aborted: event.aborted, success: event.success, willRetry: event.willRetry,
        failed: Boolean(event.errorMessage) };
    }
    return null;
  };
}

module.exports = { contentBlocks, outputMessage, skillForRead, createOutputEventAdapter };
