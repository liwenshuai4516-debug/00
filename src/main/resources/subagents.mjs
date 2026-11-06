import path from "node:path";
import { SessionManager } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import lifecycle from "./pi-session-lifecycle.js";
import { getSessionBindingError } from "../workspace/workspace-session.mjs";

const catalogType = "desktop-subagent";
const stateType = "desktop-subagent-state";
const statusLabels = { starting: "准备中", running: "运行中", completed: "已完成", stopped: "已停止", error: "失败", unknown: "执行结果待确认" };
const result = (text, details) => ({ content: [{ type: "text", text }], details });

// 只截取当前分支里已结束的模型轮次；未配平的工具调用不得进入子会话。
export function forkSubagentSession(parent, directory) {
  const entries = parent.sessionManager.getBranch();
  const end = entries.findLast(entry => entry.type === "message" && entry.message.role === "assistant"
    && entry.message.stopReason === "stop");
  if (!end || !parent.sessionFile) return SessionManager.create(parent.sessionManager.getCwd(), directory, { parentSession: parent.sessionFile });
  // 使用独立 manager 调用公开分支 API，不改变父会话的活动叶节点。
  const fork = SessionManager.open(parent.sessionFile, directory);
  fork.createBranchedSession(end.id);
  return fork;
}

export function createSubagentManager({ getParent, createChild }) {
  const children = new Map();
  let stopped = false;
  let closed = false;
  let ui;

  const parent = () => getParent();
  const directory = () => path.join(parent().sessionManager.getSessionDir(), "subagents", parent().sessionId);
  const active = () => [...children.values()].filter(child => child.work);
  const snapshot = child => ({ id: child.id, label: child.label, mode: child.mode, status: child.status,
    output: child.output?.slice(0, 12000), usage: child.usage, notified: child.notified });
  function update() {
    const rows = [...children.values()].slice(-20);
    ui?.setWidget("desktop-subagents", rows.length ? ["子智能体", ...rows.map(child => `${child.label} · ${statusLabels[child.status]} · ${child.id}`)] : undefined);
  }
  function save(child) {
    parent().sessionManager.appendCustomEntry(stateType, { owner: parent().sessionId, ...snapshot(child) });
    update();
  }
  function restore(context) {
    stopped = false;
    closed = false;
    ui = context.ui;
    children.clear();
    // owner 校验排除 fork 继承的目录；目录不从模型传入的路径重建。
    for (const entry of parent().sessionManager.getEntries()) {
      const data = entry.data;
      if (entry.type !== "custom" || data?.owner !== parent().sessionId) continue;
      if (entry.customType === catalogType) children.set(data.id, { ...data, status: "unknown", notified: true });
      if (entry.customType === stateType && children.has(data.id)) {
        Object.assign(children.get(data.id), data);
      }
    }
    for (const child of children.values()) {
      if (["starting", "running"].includes(child.status)) {
        child.status = "unknown";
        child.notified = true;
      }
    }
    update();
  }
  function checkAdmission() {
    if (closed || stopped) throw new Error("当前子任务链路已停止，请在下一次用户请求中继续。");
    if (active().length >= 8) throw new Error("已有 8 个活跃子任务，请使用现有子任务或等待完成。");
  }
  function own(id) {
    const child = children.get(id);
    if (!child) throw new Error("该子智能体不属于当前父会话。");
    return child;
  }
  async function open(child, resume) {
    const cwd = parent().sessionManager.getCwd();
    let manager;
    if (resume) {
      const file = SessionManager.findById(cwd, child.id, directory());
      if (!file) throw new Error("子会话历史缺失，无法续接；不会重建或重发旧任务。");
      const error = await getSessionBindingError(file, cwd, child.id);
      if (error) throw new Error(error);
      manager = SessionManager.open(file, directory());
      const descriptor = manager.getEntries().findLast(entry => entry.type === "custom" && entry.customType === catalogType);
      if (descriptor?.data?.owner !== parent().sessionId || descriptor.data.id !== child.id) throw new Error("子会话父子关系无效。");
    } else {
      manager = child.manager;
    }
    return createChild(manager, {
      thinkingLevel: parent().thinkingLevel,
      permissionMode: child.permissionMode,
      sendToParent: async (id, message) => {
        if (id !== parent().sessionId) throw new Error("子智能体只能向直接父会话发送消息。");
        if (stopped || closed || child.cancelled) throw new Error("父任务已停止，消息未投递。");
        await parent().sendCustomMessage({ customType: "desktop-subagent-message", content: `子智能体 ${child.label} (${child.id})：\n${message}`, display: true }, { triggerTurn: true, deliverAs: "steer" });
      },
    });
  }
  function launch(child, prompt, resume) {
    child.status = "starting";
    child.cancelled = false;
    child.notified = false;
    child.output = undefined;
    child.work = Promise.resolve().then(async () => {
      try {
        child.session = await open(child, resume);
        if (child.cancelled || stopped || closed) {
          child.status = "stopped";
          return;
        }
        child.status = "running";
        save(child);
        const startIndex = child.session.messages.length;
        await child.session.prompt(`父智能体 ID：${parent().sessionId}\n你是受委派的子智能体，不得再次委派。请完成任务并给出最终结果；可用 send_message 向直接父级汇报。\n\n${prompt}`);
        if (child.session.desktopSubagentError) throw child.session.desktopSubagentError;
        const messages = child.session.messages.slice(startIndex);
        const last = messages.findLast(message => message.role === "assistant");
        child.output = last?.content?.filter(block => block.type === "text").map(block => block.text).join("\n") ?? "";
        child.status = child.cancelled || last?.stopReason === "aborted" ? "stopped" : last?.stopReason === "stop" ? "completed" : "error";
        if (last?.errorMessage) child.output = last.errorMessage;
        child.usage = (child.usage ?? 0) + messages.filter(message => message.role === "assistant").reduce((total, message) => total + (message.usage?.totalTokens ?? 0), 0);
      } catch (error) {
        child.status = child.cancelled ? "stopped" : "error";
        child.output = error.message;
      } finally {
        try {
          await lifecycle.closePiSession(child.session);
        } catch (error) {
          child.status = "error";
          child.output = `${child.output ?? ""}\n子会话清理失败：${error.message}`;
        }
        child.session = undefined;
        child.manager = undefined;
        save(child);
      }
    }).finally(() => { child.work = undefined; });
    // 保存异常仍由边界等待传播；启动回执之后不得产生未处理的 Promise 拒绝。
    child.work.catch(() => {});
    return child.work;
  }
  async function start(mode, label, prompt, permissionMode) {
    checkAdmission();
    const manager = mode === "fork" ? forkSubagentSession(parent(), directory())
      : SessionManager.create(parent().sessionManager.getCwd(), directory(), { parentSession: parent().sessionFile });
    const child = { id: manager.getSessionId(), label, mode, permissionMode, manager };
    const data = { owner: parent().sessionId, id: child.id, label, mode, permissionMode };
    manager.appendCustomEntry(catalogType, data);
    manager.appendModelChange(parent().model.provider, parent().model.id);
    children.set(child.id, child);
    parent().sessionManager.appendCustomEntry(catalogType, data);
    launch(child, prompt, false);
    save(child);
    return result(`已启动子智能体 ${child.id}：${label}。请继续其他工作；子任务结果会在本次请求结束前自动回传。`, { subagentId: child.id });
  }
  async function send(id, message, confirmUnknown) {
    if (closed || stopped) throw new Error("父任务已停止，消息未投递。");
    const child = own(id);
    if (child.cancelled && child.work) throw new Error("子任务仍在停止中，请等待收尾。");
    if (child.session?.isStreaming) {
      await child.session.sendCustomMessage({ customType: "desktop-parent-message", content: message, display: true }, { triggerTurn: true, deliverAs: "steer" });
    } else {
      if (child.work) throw new Error("子任务正在准备或收尾，消息未投递。");
      if (child.status === "unknown" && !await confirmUnknown?.()) throw new Error("上次子任务结果未确认，用户未确认续接；消息未投递，不会重发旧任务。");
      checkAdmission();
      launch(child, message, true);
    }
    return result(`消息已接收：${id}。回答将另外回传。`, { subagentId: id });
  }
  async function interrupt(id) {
    const child = own(id);
    child.cancelled = true;
    await child.session?.abort();
    await child.work;
    return result(`子任务已停止：${id}；历史保留。`, { subagentId: id });
  }
  async function stop(close = false) {
    stopped = true;
    closed ||= close;
    const running = active();
    for (const child of running) child.cancelled = true;
    await Promise.all(running.map(async child => {
      await child.session?.abort();
      await child.work;
    }));
  }
  async function settle(event) {
    if (event.outcome !== "completed") {
      await stop();
      return;
    }
    await Promise.all(active().map(child => child.work));
    const ready = [...children.values()].filter(child => !child.notified && !child.work);
    if (stopped || !event.context.canContinue || ready.length === 0) return;
    const entries = [];
    for (const child of ready) {
      child.notified = true;
      entries.push({ type: "custom_message", customType: "desktop-subagent-result", display: true,
        content: `子智能体 ${child.label} (${child.id})：${statusLabels[child.status]}\n${(child.output || "没有返回正文。").slice(0, 12000)}\n以上正文最多展示 12000 字符。子任务累计用量：${child.usage ?? "未知"} tokens（不含继承历史）。完整历史在 ${directory()}。` });
      entries.push({ type: "custom", customType: stateType, data: { owner: parent().sessionId, ...snapshot(child) } });
    }
    return { entries, continue: true };
  }
  return { restore, start, send, interrupt, stop, settle,
    begin: () => { if (!closed) stopped = false; },
    list: () => result(JSON.stringify([...children.values()].map(snapshot), null, 2), {}),
  };
}

export function createSubagentExtension(manager, getPermissionMode) {
  return pi => {
    pi.on("session_start", (_event, ctx) => manager.restore(ctx));
    pi.on("agent_start", () => manager.begin());
    pi.on("agent_before_settle", event => manager.settle(event));
    pi.on("session_shutdown", () => manager.stop(true));
    for (const mode of ["spawn", "fork"]) pi.registerTool({
      name: mode === "spawn" ? "subagent" : "subagent_fork", label: mode === "spawn" ? "委派子智能体" : "分叉子智能体",
      description: `${mode === "spawn" ? "以全新上下文" : "继承父级已完成轮次"}启动独立子任务，立即返回 ID。最多并行 8 个，子级不能再次委派。`,
      promptGuidelines: ["独立任务可一起委派，期间继续其他工作。无需休眠或轮询；结果在请求收尾前自动回传。不要让多个子任务同时修改同一文件。"],
      parameters: Type.Object({ description: Type.String({ minLength: 1 }), prompt: Type.String({ minLength: 1 }) }),
      execute: (_id, args) => manager.start(mode, args.description, args.prompt, getPermissionMode()),
    });
    registerMessageTool(pi, (id, message, ctx) => manager.send(id, message, async () => ctx.hasUI
      && await ctx.ui.confirm("续接结果未确认的子任务？", `子智能体 ${id} 上次执行结果未知。请先核对历史与实际文件；继续只发送本次新消息，不重发旧任务。`)));
    pi.registerTool({ name: "list_agents", label: "子智能体列表", description: "列出本父会话的子任务状态、输出和用量。",
      parameters: Type.Object({}), execute: async () => manager.list() });
    pi.registerTool({ name: "interrupt_agent", label: "停止子智能体", description: "停止本父会话的指定子任务并等待其资源释放，历史保留。",
      parameters: Type.Object({ agent_id: Type.String() }), execute: (_id, args) => manager.interrupt(args.agent_id) });
    pi.registerCommand("subagents", { description: "查看当前父会话的子智能体状态与输出（不请求模型）", handler: async () => {
      pi.sendMessage({ customType: "desktop-subagent-list", content: manager.list().content, display: true });
    } });
  };
}

function registerMessageTool(pi, send) {
  pi.registerTool({ name: "send_message", label: "智能体消息", description: "向直接相邻的智能体发送消息，返回投递确认，回答另行回传。",
    parameters: Type.Object({ agent_id: Type.String(), message: Type.String({ minLength: 1 }) }),
    execute: async (_id, args, _signal, _onUpdate, ctx) => {
      const delivered = await send(args.agent_id, args.message, ctx);
      return delivered ?? result("消息已投递。", {});
    } });
}

export function createSubagentReplyExtension(send) {
  return pi => {
    registerMessageTool(pi, send);
    pi.on("tool_call", event => {
      if (["subagent", "subagent_fork"].includes(event.toolName)) return { block: true, reason: "已达到子智能体委派深度上限 1。" };
    });
  };
}
