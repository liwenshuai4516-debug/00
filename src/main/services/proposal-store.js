const { randomUUID } = require("node:crypto");

// 登记与恢复使用相同的新建草稿字段约束。
function isCreateProposal(proposal) {
  return (
    proposal?.kind === "create-proposal" &&
    typeof proposal.path === "string" &&
    Boolean(proposal.path) &&
    typeof proposal.content === "string" &&
    !proposal.content.includes("\0") &&
    Buffer.byteLength(proposal.content, "utf8") <= 32 * 1024
  );
}

// 未传 storage 时使用纯内存，现有单元测试无需依赖磁盘。
function createProposalStore(storage) {
  const sessions = new Map();

  function getSession(sessionId) {
    if (!sessions.has(sessionId)) {
      const records = storage ? storage.load(sessionId) : [];
      const restored = new Map();

      for (const record of records) {
        // 不同草稿类型分别校验各自的内容字段。
        const validFields =
          record?.kind === "create-proposal"
            ? isCreateProposal(record)
            : record?.kind === "edit-proposal" &&
              typeof record.oldText === "string" &&
              Boolean(record.oldText) &&
              record.oldText.length <= 1000 &&
              typeof record.newText === "string" &&
              record.newText.length <= 1000 &&
              record.oldText !== record.newText &&
              typeof record.baseTextHash === "string" &&
              /^[a-f0-9]{64}$/.test(record.baseTextHash);

        if (
          !record ||
          record.sessionId !== sessionId ||
          typeof record.id !== "string" ||
          !record.id ||
          restored.has(record.id) ||
          !validFields ||
          typeof record.path !== "string" ||
          !record.path ||
          typeof record.written !== "boolean" ||
          (record.applying !== undefined &&
            typeof record.applying !== "boolean")
        ) {
          throw new Error("草稿字段无效或编号重复，请检查本地草稿记录。");
        }

        restored.set(record.id, Object.freeze({ ...record }));
      }

      // 全部检查通过后才采用，避免部分恢复。
      sessions.set(sessionId, restored);
    }

    return sessions.get(sessionId);
  }

  function persist(sessionId, records) {
    storage?.save(sessionId, [...records.values()]);
  }

  function add(sessionId, proposal) {
    if (
      typeof sessionId !== "string" ||
      !sessionId ||
      (proposal.kind !== "edit-proposal" && !isCreateProposal(proposal)) ||
      proposal.written !== false
    ) {
      throw new Error("无法登记无效的修改草稿。");
    }

    const records = getSession(sessionId);

    // 按类型挑选字段，不采用工具传来的编号或会话归属。
    const fields =
      proposal.kind === "create-proposal"
        ? {
            content: proposal.content,
          }
        : {
            oldText: proposal.oldText,
            newText: proposal.newText,
            baseTextHash: proposal.baseTextHash,
          };

    const stored = Object.freeze({
      id: randomUUID(),
      sessionId,
      kind: proposal.kind,
      path: proposal.path,
      ...fields,
      written: false,
    });

    const next = new Map(records);
    next.set(stored.id, stored);

    // 先落盘再公布，失败不会留下可操作的内存草稿。
    persist(sessionId, next);
    sessions.set(sessionId, next);

    return { ...stored };
  }

  function get(sessionId, id) {
    const proposal = getSession(sessionId).get(id);

    if (!proposal) {
      throw new Error("当前会话中不存在该修改草稿。");
    }

    return { ...proposal };
  }

  function beginApply(sessionId, id) {
    const proposal = get(sessionId, id);

    if (proposal.written) {
      throw new Error("该草稿已经保存，无需重复保存。");
    }

    if (proposal.applying) {
      throw new Error("上次保存未确认完成，请检查文件并重新生成草稿。");
    }

    const next = new Map(getSession(sessionId));
    next.set(id, Object.freeze({ ...proposal, applying: true }));

    // 写文件前先持久化进行中状态。
    persist(sessionId, next);
    sessions.set(sessionId, next);
  }

  function cancelApply(sessionId, id) {
    const proposal = get(sessionId, id);
    const records = getSession(sessionId);

    records.set(
      id,
      Object.freeze({
        ...proposal,
        applying: false,
      }),
    );

    persist(sessionId, records);
  }

  function markWritten(sessionId, id) {
    const proposal = get(sessionId, id);

    if (proposal.written) {
      throw new Error("该草稿已经保存，无需重复保存。");
    }

    const updated = Object.freeze({
      ...proposal,
      written: true,
      applying: false,
    });

    const records = getSession(sessionId);

    // 文件已经写入，先更新内存。
    // 即使落盘失败，也不能允许本进程重复保存。
    records.set(id, updated);
    persist(sessionId, records);

    return { ...updated };
  }
  function discard(sessionId, id) {
    // get 同时检查草稿存在性和会话归属。
    const proposal = get(sessionId, id);

    if (proposal.written) {
      throw new Error("该草稿已经保存，不能放弃。");
    }

    if (proposal.applying) {
      throw new Error("上次保存结果尚未确认，请检查文件并重新生成草稿。");
    }

    // 在副本中删除，快照写入失败时仍保留原来的内存状态。
    const next = new Map(getSession(sessionId));
    next.delete(id);

    // 快照保存成功后，才采用新的内存状态。
    persist(sessionId, next);
    sessions.set(sessionId, next);

    return {
      id: proposal.id,
      path: proposal.path,
    };
  }

  function listPending(sessionId) {
    return [...getSession(sessionId).values()]
      .filter((proposal) => !proposal.written)
      .map((proposal) => ({
        id: proposal.id,
        path: proposal.path,
      }));
  }

  return {
    add,
    get,
    beginApply,
    cancelApply,
    markWritten,
    discard,
    listPending,
  };
}

module.exports = { createProposalStore };
