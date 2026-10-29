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
) {
  let activeRequest;

  function isBusy() {
    return Boolean(activeRequest);
  }

  async function send(text, onText, onToolEvent) {
    if (typeof text !== "string" || !text.trim()) {
      throw new Error("请输入消息内容。");
    }

    if (activeRequest) {
      throw new Error("已有消息正在生成。");
    }

    // 在任何异步操作之前占用请求状态，防止重复发送。
    const request = { stopped: false, session: null };
    activeRequest = request;

    try {
      const sendMessage = await loadSender();
      const session = await sessionService.getSession();

      // 初始化期间也允许停止，此时不发起模型请求。
      if (request.stopped) {
        return { stopped: true };
      }

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
              event.name === "propose_workspace_edit" &&
              !event.isError &&
              event.proposal
            ) {
              let proposal;

              try {
                proposal = proposalStore.add(session.sessionId, event.proposal);
              } catch (error) {
                // 存储失败作为应用错误展示，不公布保存按钮。
                onToolEvent({
                  type: "end",
                  name: "登记修改草稿",
                  isError: true,
                  text: `草稿未登记，无法保存：${error.message}`,
                });
                return;
              }

              onToolEvent({ ...event, proposal });

              // 当前工具事件已经处理完成，不再继续向下转发。
              return;
            }

            onToolEvent(event);
          },
        );
      } catch (error) {
        // 主动停止产生的中断不作为请求失败展示。
        if (!request.stopped) throw error;
      }

      return { stopped: request.stopped };
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
      await request.session.abort();
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

  return {
    send,
    stop,
    isBusy,
    getProposal,
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
