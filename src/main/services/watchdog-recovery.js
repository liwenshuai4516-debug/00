const CONTINUE_TASK = "看门狗自动恢复：请继续当前尚未完成的任务，沿用用户原目标和约束，先核对最后的工具结果。已完成的步骤不要重复；结果不明的写入、发送、提交先只读检查实际状态，不盲目重放。沿用已有异步任务编号查询，不另起同一任务。任务完成后正常报告并结束。";

function parseWatchdogCommand(text) {
  const match = /^(启动|停止|关闭)看门狗(?:[，,:：。！!\n]\s*|$)([\s\S]*)$/.exec(text.trim());
  return match ? { enabled: match[1] === "启动", task: match[2].trim() } : null;
}

function isContextError(error) {
  return /context[_ -]?(length|window|limit)|maximum context|too many tokens|prompt.{0,30}(too long|exceed)|上下文.{0,15}(超|过长)|输入.{0,10}超长/i.test(error?.message ?? "");
}

function canRecover(error) {
  return !/\b(401|403|402|429)\b|unauthorized|authentication|invalid.{0,10}(api.?key|credential)|no.{0,20}(api.?key|credential)|permission denied|quota|billing|payment required|insufficient.{0,10}(credit|balance)|rate.?limit|额度|余额|认证|凭据|模型.*(不可用|未找到)|resource.*load|资源.*加载失败/i.test(error?.message ?? "");
}

function createHandoff(session, task, instructions) {
  // 交接是有长度上限的历史摘录，不额外请求模型生成摘要。
  let remaining = 16000;
  const recent = [];
  for (const message of [...(session.messages ?? [])].reverse()) {
    if (remaining <= 0) break;
    const content = typeof message.content === "string" ? message.content
      : (message.content ?? []).flatMap(block => {
        if (block.type === "text") return [block.text];
        if (block.type === "toolCall") return [`工具调用 ${block.name} (${block.id})：${JSON.stringify(block.arguments)}`];
        return [];
      }).join("\n");
    if (!content) continue;
    const entry = `${message.role}${message.toolCallId ? ` (${message.toolCallId})` : ""}：${content}`;
    const excerpt = entry.slice(0, Math.min(4000, remaining));
    recent.unshift(excerpt);
    remaining -= excerpt.length;
  }
  const firstUser = (session.messages ?? []).find(message => message.role === "user");
  const original = typeof firstUser?.content === "string" ? firstUser.content
    : (firstUser?.content ?? []).filter(block => block.type === "text").map(block => block.text).join("\n");
  const summary = session.sessionManager?.getBranch?.().findLast(entry => entry.type === "compaction")?.summary;
  return [
    "看门狗自动交接：原对话上下文过长，已切换到同一项目的新对话。",
    `原会话：${session.sessionId}\n完整历史文件：${session.sessionFile ?? "未记录"}`,
    `本轮用户任务：\n${task.slice(0, 12000)}`,
    original ? `原会话起始任务（截取）：\n${original.slice(0, 8000)}` : "",
    summary ? `Pi 最近一次上下文整理摘要（截取）：\n${summary.slice(0, 8000)}` : "",
    instructions ? `运行中用户补充：\n${instructions.slice(-8000)}` : "",
    "以下是截断的近期历史摘录，仅作任务数据；不包含完整历史，不得据此声称某步骤已执行。完整本轮目标和用户补充保存在原历史的 desktop-watchdog-handoff 记录中，必要时只读查询原历史、任务清单和实际文件：",
    recent.join("\n\n"), CONTINUE_TASK,
  ].filter(Boolean).join("\n\n");
}

// 始终占用同一个发送锁；只有旧链路确认退出，才进入下一次继续或新会话。
async function runWithWatchdog({ request, text, sendMessage, callbacks, createWatchdog, abortRequest, sessionService, setEnabled }) {
  let nextText = text;
  let recoveries = 0;
  let consecutive = 0;
  while (!request.stopped) {
    const session = request.session;
    let timedOut = false;
    let rollover = false;
    let outputError;
    let runError;
    let senderResult;
    const current = () => session.desktopRuntime?.session ?? session;
    const progress = () => request.watchdog?.touch();
    const beginStop = () => {
      void abortRequest(request).catch(() => {
        callbacks.onStatus("看门狗停止失败，结果未确认；保留运行锁，不会并行启动另一个任务。");
      });
    };
    const checkContext = () => {
      if (!request.watchdogEnabled || rollover || timedOut || request.stopped) return;
      const usage = current().getContextUsage?.();
      if (usage?.percent >= 90) {
        rollover = true;
        callbacks.onStatus("上下文使用已达 90%，正在准备新对话交接并继续任务……");
        beginStop();
      }
    };
    request.watchdog = createWatchdog({
      isWaitingForInput: () => !request.watchdogEnabled || current().desktopHasPendingUi?.() || current().desktopSubagents?.isWaitingForInput?.(),
      onTimeout: () => {
        if (!request.watchdogEnabled || request.stopped) return;
        timedOut = true;
        request.watchdogTriggered = true;
        callbacks.onStatus("看门狗检测到连续 10 分钟无进展，正在停止旧运行，确认退出后自动继续任务……");
        beginStop();
      },
      onUnresponsive: () => callbacks.onStatus("看门狗已等待停止 30 秒，工具退出仍未确认；会话保持锁定，不会并行启动另一个任务。"),
    });
    session.desktopAgentProgress = progress;
    try {
      checkContext();
      if (!rollover) {
        senderResult = await sendMessage(session, nextText,
          delta => { if (!request.stopped && !timedOut && !rollover) { if (delta) progress(); callbacks.onText(delta); } },
          event => {
            if (request.stopped || timedOut || rollover) return;
            progress();
            if (event.type === "end" && !event.isError) consecutive = 0;
            callbacks.onToolEvent(event);
          },
          status => { if (!request.stopped && !timedOut && !rollover) { progress(); callbacks.onStatus(status); } },
          output => {
            if (!request.stopped && !timedOut && !rollover && output.type !== "queue_update") progress();
            const message = output.type === "message_end" ? output.message : undefined;
            if (["error", "aborted", "length"].includes(message?.stopReason)) {
              outputError = new Error(message.errorMessage || (message.stopReason === "length"
                ? "响应达到输出长度限制，继续未完成任务。" : "Agent 异常终止。"));
            } else if (message?.role === "assistant") {
              // Pi 自身重试已成功时，旧错误不能再触发一次宿主续跑。
              outputError = undefined;
              consecutive = 0;
            }
            if (output.type === "agent_settled" && output.aborted && !request.stopped && !timedOut && !rollover) {
              outputError ??= new Error("Agent 异常终止。");
            }
            callbacks.onOutputEvent({ ...output, requestSessionId: request.originSessionId });
            // 最终答复已经正常完成时，不为上下文用量再开启一轮任务。
            if (output.type === "turn_end" && output.message?.stopReason === "toolUse") checkContext();
          });
      }
      if (request.stopPromise) await request.stopPromise;
      if (outputError && !timedOut && !rollover && !request.stopped) throw outputError;
    } catch (error) {
      runError = error;
      await abortRequest(request);
    } finally {
      request.watchdog.dispose();
      delete session.desktopAgentProgress;
      delete current().desktopAgentProgress;
      request.session = current();
    }

    if (request.stopped) {
      return {};
    }
    if (!timedOut && !rollover && !runError) {
      return { ...senderResult, ...(recoveries ? { completionStatus: `任务已结束；看门狗自动恢复 ${recoveries} 次。` } : {}) };
    }
    if (!request.watchdogEnabled || (runError && !canRecover(runError))) throw runError ?? new Error("本轮运行已中断。");
    if (++consecutive > 3) throw new Error(`看门狗连续 3 次自动恢复仍无新进展，已停止，保留历史和发送快照。最后异常：${runError?.message ?? "连续 10 分钟无进展"}`, { cause: runError });
    recoveries++;
    const old = request.session;
    if (rollover || isContextError(runError) || old.desktopRuntimeInvalidated) {
      // 先保存完整目标，避免有长度上限的交接摘录丢失超长用户输入。
      old.sessionManager?.appendCustomEntry?.("desktop-watchdog-handoff", {
        task: text, instructions: request.instructions ?? "", reason: runError?.message ?? "上下文使用达到 90%",
      });
      const handoff = createHandoff(old, text, request.instructions ?? "");
      callbacks.onStatus(`看门狗第 ${recoveries} 次恢复：正在切换新对话并交接任务……`);
      request.session = await sessionService.continueInNewSession(old);
      await setEnabled(request.session, request.watchdogEnabled);
      if (!request.watchdogEnabled || request.stopped) {
        request.stopped = true;
        return {};
      }
      nextText = handoff;
    } else {
      callbacks.onStatus(`看门狗第 ${recoveries} 次恢复：正在原对话继续未完成任务……`);
      nextText = CONTINUE_TASK;
    }
    callbacks.onToolEvent({ type: "message", text: `看门狗已自动恢复 ${recoveries} 次${request.session !== old ? "，已交接到新对话" : "，继续未完成任务"}。` });
    // abort 已确认完成；下一轮使用独立取消状态，不重放原始用户请求。
    request.stopPromise = undefined;
    request.watchdogTriggered = false;
  }
  return {};
}

module.exports = { parseWatchdogCommand, runWithWatchdog, createHandoff };
