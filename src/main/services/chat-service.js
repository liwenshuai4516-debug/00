const { createProposalStore } = require("./proposal-store.js");

// 延迟加载 Pi，并返回真正执行发送的函数。
async function loadDefaultSender() {
  const { sendMessage } = await import("../pi-agent.mjs");
  return sendMessage;
}

function createChatService(
  sessionService,
  loadSender = loadDefaultSender,
  proposalStore = createProposalStore(),
  sessionStateStore,
) {
  let activeRequest;

  function isBusy() {
    return Boolean(activeRequest);
  }

  async function send(
    text,
    onText,
    onToolEvent,
    onStatus = () => {},
    draftRequest,
    onDraftConsumed = () => {},
  ) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("请输入消息内容。");
    }

    if (activeRequest) {
      throw new Error("已有消息正在生成。");
    }

    // 在等待初始化前固定编号和版本，不接受页面指定的工作目录。
    const draft =
      draftRequest === undefined
        ? null
        : {
            sessionId: draftRequest?.sessionId,
            revision: draftRequest?.revision,
          };
    if (
      draft &&
      (!sessionStateStore ||
        typeof draft.sessionId !== "string" ||
        !draft.sessionId ||
        !Number.isSafeInteger(draft.revision) ||
        draft.revision < 0)
    ) {
      throw new Error("发送会话或输入版本无效，或尚未接入输入存储。");
    }

    // 在任何异步操作之前占用请求状态，防止重复发送。
    const request = { stopped: false, session: null };
    activeRequest = request;
    let consumed;
    let workspaceDir;
    let registrationWarning;

    try {
      const sendMessage = await loadSender();
      const session = await sessionService.getSession();

      if (draft) {
        if (session.sessionId !== draft.sessionId) {
          throw new Error("当前会话已变化，请重新确认输入后再发送。");
        }

        workspaceDir = session.sessionManager.getCwd();
        const state = await sessionStateStore.consumeDraft(
          session.sessionId,
          workspaceDir,
          text,
          draft.revision,
        );
        consumed = {
          sessionId: session.sessionId,
          sendId: state.pendingSend.id,
          text: state.draft.text,
          revision: state.draft.revision,
        };

        // 同步通知消费后的版本；仅传副本，避免回调改动后续清理编号。
        onDraftConsumed({ ...consumed });
      }

      // 初始化或消费期间停止时，仍完成草稿收尾，但不调用模型。
      if (!request.stopped) {
        request.session = session;

        try {
          await sendMessage(
            session,
            text.trim(),
            (delta) => {
              if (!request.stopped) onText(delta);
            },
            (event) => {
              if (request.stopped) return;

              if (
                event.type === "end" &&
                ["propose_workspace_edit", "propose_workspace_create"].includes(
                  event.name,
                ) &&
                !event.isError &&
                event.proposal
              ) {
                let proposal;

                try {
                  proposal = proposalStore.add(
                    session.sessionId,
                    event.proposal,
                  );
                } catch (error) {
                  // 存储失败作为应用错误展示，不公布保存按钮。
                  onToolEvent({
                    type: "end",
                    // 登记失败也属于原工具调用，页面需要更新原记录。
                    toolCallId: event.toolCallId,
                    name: "登记文件草稿",
                    isError: true,
                    text: `草稿未登记，无法保存：${error.message}`,
                  });
                  return;
                }

                onToolEvent({ ...event, proposal });
                return;
              }

              onToolEvent(event);
            },
            // 停止后的状态不能覆盖页面上的停止提示。
            (status) => {
              if (!request.stopped) onStatus(status);
            },
          );
        } catch (error) {
          // 主动停止产生的中断不作为请求失败展示。
          if (!request.stopped) throw error;
        } finally {
          try {
            const actual = session.desktopRuntime?.session ?? session;
            await sessionService.syncSessionRegistration?.(actual.sessionId);
          } catch (error) {
            // 本地登记失败不改变已经完成的请求结果；保留快照供后续核对。
            registrationWarning = `恢复登记同步失败：${error.message}${consumed ? "；发送快照未清理。" : "。"}`;
          }
        }
      }

      const actual = session.desktopRuntime?.session ?? session;
      const result = {
        ...((actual !== session || session.desktopHistoryChanged === true) ? { sessionChanged: true } : {}),
        stopped: request.stopped,
        ...(registrationWarning ? { warning: registrationWarning } : {}),
      };
      session.desktopHistoryChanged = false;
      if (!consumed) return result;
      result.outcome = request.stopped ? "stopped" : "completed";
      result.draft = consumed;
      if (registrationWarning) return result;

      try {
        await sessionStateStore.completeSend(
          consumed.sessionId,
          workspaceDir,
          consumed.sendId,
        );
      } catch (error) {
        // 回复已结束，收尾失败不能变成可自动恢复原文的请求失败。
        result.warning = `请求已结束，但发送快照清理失败：${error.message}`;
      }

      return result;
    } catch (error) {
      if (!consumed) throw error;

      // 消费后异常不能证明远端未处理；保留快照，页面不可自动重发。
      return {
        stopped: request.stopped,
        ...(request.session?.desktopRuntime && request.session.desktopRuntime.session !== request.session ? { sessionChanged: true } : {}),
        outcome: "unconfirmed",
        draft: consumed,
        error: error.message,
        ...(registrationWarning ? { warning: registrationWarning } : {}),
      };
    } finally {
      // 成功、失败或停止后，都允许下一次发送。
      activeRequest = undefined;
    }
  }

  async function stop() {
    const request = activeRequest;
    if (!request) return;

    request.stopped = true;

    // session 赋值后，发送函数已经进入执行阶段。
    if (request.session) {
      const current = request.session.desktopRuntime?.session ?? request.session;
      current.desktopCancelUi?.();
      await current.abort();
    }
  }

  // 与 send、stop 同级，按当前会话查找已登记的草稿。
  async function getProposal(id) {
    const session = await sessionService.getSession();
    return proposalStore.get(session.sessionId, id);
  }

  // 使用保存开始时取得的会话编号，不重新查询当前会话。
  function markProposalWritten(sessionId, id) {
    return proposalStore.markWritten(sessionId, id);
  }

  // 会话编号从主进程取得，页面不能指定其他会话。
  async function listProposals() {
    const session = await sessionService.getSession();
    return proposalStore.listPending(session.sessionId);
  }

  // 会话归属由主进程取得，页面只能提交草稿编号。
  async function discardProposal(id) {
    const session = await sessionService.getSession();

    return proposalStore.discard(session.sessionId, id);
  }
  return {
    send,
    stop,
    isBusy,
    getProposal,
    discardProposal,
    markProposalWritten,

    // 由保存服务控制保存开始和失败恢复。
    beginProposalApply: (sessionId, id) =>
      proposalStore.beginApply(sessionId, id),

    cancelProposalApply: (sessionId, id) =>
      proposalStore.cancelApply(sessionId, id),

    listProposals,
  };
}

module.exports = { createChatService };
