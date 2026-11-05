// 应用层工具权限门禁：Pi 没有内建审批器，这里用官方 tool_call 扩展拦截。
// 只控制模型发起的工具调用；扩展/子进程仍拥有应用本身的系统权限，不是沙箱。

const READ_ONLY_TOOLS = new Set([
  "read",
  "read_workspace_text_file",
  "read_workspace_lines",
  "list_workspace_directory",
  "search_workspace_text",
  "get_current_time",
  "todo_write",
  "qa_ui_project",
  "web_search",
  "web_fetch",
  "glob",
  "grep",
  "ls",
  "find",
  "tool_search",
  // 上下文管理只改当前对话，不写文件或执行命令；避免每次压缩都弹窗。
  "compress",
  "decompress",
  "acp_status",
  "search_context",
  "acp_retrieve",
]);

// 官方 Playwright 录制工具里只读的观察类操作；其他 browser_*/generator_* 仍按写入处理。
const READ_ONLY_MCP_TOOLS = new Set([
  "browser_snapshot",
  "browser_wait_for",
  "browser_console_messages",
  "browser_network_requests",
  "browser_network_request",
  "browser_get_config",
  "browser_take_screenshot",
  "browser_generate_locator",
  "browser_cookie_list",
  "browser_cookie_get",
  "browser_tab_list",
  "generator_read_log",
]);
const READ_ONLY_MCP_PREFIXES = ["browser_verify_"];
const PERMISSION_SECTION = "app-permission";

function shortToolName(name) {
  const index = name.lastIndexOf("__");
  return index >= 0 ? name.slice(index + 2) : name;
}

function toolInfo(pi, name) {
  try {
    return pi.getAllTools().find((tool) => tool.name === name) ?? null;
  } catch {
    return null;
  }
}

function isReadOnly(pi, name) {
  const tool = toolInfo(pi, name);
  if (tool?.annotations?.readOnlyHint === true) return true;
  if (tool?.annotations?.destructiveHint === true) return false;
  const short = shortToolName(name);
  if (READ_ONLY_TOOLS.has(short)) return true;
  if (READ_ONLY_MCP_TOOLS.has(short)) return true;
  return READ_ONLY_MCP_PREFIXES.some((prefix) => short.startsWith(prefix));
}

function clip(value, max = 500) {
  const text = typeof value === "string" ? value.trim() : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function describeToolCall(event) {
  const input = event?.input ?? {};
  if (event.toolName === "bash" && typeof input.command === "string") {
    return `命令：${clip(input.command)}`;
  }
  const target = input.path ?? input.file ?? input.targetUrl ?? input.url ?? input.cwd;
  if (typeof target === "string" && target.trim()) return `目标：${clip(target, 300)}`;
  if (event.toolName.startsWith("qa_ui_") && typeof input.mode === "string") {
    return `QA 操作：${clip(input.mode, 40)}`;
  }
  return "该工具可能修改文件、执行命令或访问外部资源。";
}

// 权限模式必须同时约束工具门禁和模型行为；否则完全权限下模型仍会按“未授权”停下。
export function permissionPromptText(mode) {
  if (mode === "full-access") {
    return [
      "当前应用权限模式为「完全权限」（full-access）。",
      "本节优先于技能中的默认确认或“未授权只读”规则。",
      "用户已明确选择完全权限，视为已授权本次任务所需的工具调用、文件写入、命令、登录、录制和测试环境写操作。",
      "不要逐项询问，也不要仅因环境或写操作授权不足而只做只读；按用户提示词完成工作。",
      "只有用户明确说明目标是生产环境且操作不可逆（真实付款、外部通知、删除非测试数据）时，先说明风险并等待一次确认。",
      "该授权是应用层工具门禁，不改变操作系统权限。",
    ].join("\n");
  }
  if (mode === "read-only") {
    return [
      "当前应用权限模式为「只读」（read-only）。",
      "只能读取、搜索和项目检查；写入、命令、登录、录制等会被应用阻止。",
      "不要尝试或声称执行这些操作；按只读范围完成，并在报告中列出未覆盖项及原因。",
    ].join("\n");
  }
  return [
    "当前应用权限模式为「每次确认」（ask）。",
    "读取、搜索和项目检查直接执行；写入、命令、登录、录制等由应用逐次弹窗确认。",
    "需要写操作时直接调用工具，由应用弹窗确认；工具层不再逐项征求同意。若技能要求先确认测试环境而任务尚未说明，仍先确认一次。",
    "不要声称完全权限或跳过确认；用户拒绝时按拒绝处理，并在结果中说明。",
  ].join("\n");
}

export function createPermissionExtension(controller) {
  return (pi) => {
    // 权限按会话/项目解析；读取实际 sessionId 与工作区，避免页面或旧全局模式误判。
    function permissionContext(ctx) {
      let sessionId = "";
      try {
        sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
      } catch {
        sessionId = "";
      }
      const workspace = typeof ctx?.cwd === "string" ? ctx.cwd : "";
      return { sessionId, workspace };
    }

    // 每次用户提交前刷新系统提示词，使模式切换在下一轮立即对模型可见。
    pi.on("before_agent_start", (event, ctx) => {
      const options = event?.systemPromptOptions;
      if (!options || typeof options !== "object") return;
      if (!options.sections || typeof options.sections !== "object") options.sections = {};
      options.sections[PERMISSION_SECTION] = permissionPromptText(
        controller?.currentMode?.(permissionContext(ctx)) ?? "ask",
      );
    });

    pi.on("tool_call", async (event, ctx) => {
      const context = permissionContext(ctx);
      const mode = controller?.currentMode?.(context) ?? "ask";
      if (mode === "full-access") return undefined;
      if (isReadOnly(pi, event.toolName)) return undefined;

      if (mode === "read-only") {
        return {
          block: true,
          reason: `当前权限为「只读」，已阻止 ${event.toolName}。请到「设置 → 通用 → 权限控制」调整权限后重试。`,
        };
      }

      if (!ctx?.hasUI) {
        return {
          block: true,
          reason: `当前权限为「每次确认」，但界面不可用，已按拒绝处理 ${event.toolName}。`,
        };
      }

      let allowed = false;
      try {
        allowed = await ctx.ui.confirm(
          `允许执行 ${event.toolName}？`,
          `${describeToolCall(event)}\n\n权限：每次确认。批准只对本次调用有效。`,
        );
      } catch {
        allowed = false;
      }
      if (!allowed) {
        return { block: true, reason: `用户未批准 ${event.toolName}。` };
      }
      // 确认期间权限可能已被调整；再次读取，避免已切换为只读后仍执行。
      if ((controller?.currentMode?.(context) ?? "ask") === "read-only") {
        return { block: true, reason: `当前权限为「只读」，已阻止 ${event.toolName}。` };
      }
      return undefined;
    });
  };
}
