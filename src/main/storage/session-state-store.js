const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");
const { validatePromptSettings } = require("./prompt-settings-store.js");

function createSessionStateStore(directory) {
  // 应用入口共用此实例；同一会话的读取、修改和写入依次执行。
  const pending = new Map();

  function getFilename(sessionId) {
    if (
      typeof sessionId !== "string" ||
      !/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(sessionId)
    ) {
      throw new Error("无效的会话编号。");
    }
    return path.join(directory, `${sessionId}.json`);
  }

  function isRevision(value) {
    return Number.isSafeInteger(value) && value >= 0;
  }

  function validateRegistration(registration) {
    if (
      !["empty", "history"].includes(registration?.source) ||
      typeof registration.model?.provider !== "string" ||
      !registration.model.provider.trim() ||
      typeof registration.model?.modelId !== "string" ||
      !registration.model.modelId.trim()
    ) {
      throw new Error("会话恢复登记无效。");
    }
  }

  function validate(state, sessionId) {
    if (
      state?.version !== 1 ||
      state.sessionId !== sessionId ||
      typeof state.workspaceDir !== "string" ||
      !path.isAbsolute(state.workspaceDir) ||
      typeof state.draft?.text !== "string" ||
      !isRevision(state.draft.revision) ||
      !(state.pinnedAt === null || isRevision(state.pinnedAt)) ||
      !(state.archivedAt === null || isRevision(state.archivedAt))
    ) {
      throw new Error("会话状态记录无效或归属不匹配。");
    }

    // 旧记录没有来源证明，保持未登记；不能据此认定它是空会话。
    if (state.watchdogEnabled !== undefined && typeof state.watchdogEnabled !== "boolean") {
      throw new Error("看门狗开关记录无效。");
    }
    if (state.registration !== undefined) {
      validateRegistration(state.registration);
    }

     // 兼容没有快照的旧记录；一旦存在快照就必须完整有效。
    if (state.promptSnapshot !== undefined) {
      validatePromptSettings(state.promptSnapshot);
      if (!["new", "legacy"].includes(state.promptSnapshot.origin)) {
        throw new Error("会话提示词快照来源无效，请保留原文件并检查。");
      }
    }

    // 旧记录可以没有此字段；非空快照必须对应已经消费的输入版本。
    const sending = state.pendingSend;
    if (
      sending !== undefined &&
      sending !== null &&
      (typeof sending.id !== "string" ||
        !sending.id ||
        typeof sending.text !== "string" ||
        !sending.text.trim() ||
        !isRevision(sending.draftRevision) ||
        sending.draftRevision >= state.draft.revision)
    ) {
      throw new Error("发送快照记录无效，请保留原文件并检查。");
    }
  }

  async function read(sessionId, filename) {
    let text;
    try {
      text = await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }

    let state;
    try {
      state = JSON.parse(text);
    } catch (error) {
      throw new Error("会话状态记录损坏，请保留原文件并检查。", {
        cause: error,
      });
    }
    validate(state, sessionId);
    return state;
  }

  async function load(sessionId) {
    const filename = getFilename(sessionId);
    await pending.get(sessionId);
    return read(sessionId, filename);
  }

  // 只枚举已落盘的状态，不创建目录；每条仍经load的队列等待与校验。
  async function list() {
    await Promise.all([...pending.values()]);
    let filenames;
    try {
      filenames = await fs.readdir(directory);
    } catch (error) {
      if (error.code === "ENOENT") return [];
      throw error;
    }
    const states = [];
    for (const filename of filenames
      .filter((name) => name.endsWith(".json"))
      .sort()) {
      const state = await load(filename.slice(0, -5));
      if (state) states.push(state);
    }
    return states;
  }

  // change 仅供主进程传入同步更新函数，不能直接暴露给页面。
  async function update(sessionId, workspaceDir, change) {
    const filename = getFilename(sessionId);
    if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) {
      throw new Error("工作目录必须是绝对路径。");
    }

    const result = (pending.get(sessionId) ?? Promise.resolve()).then(
      async () => {
        const current = await read(sessionId, filename);
        const state = current ?? {
          version: 1,
          sessionId,
          workspaceDir,
          draft: { text: "", revision: 0 },
          pinnedAt: null,
          archivedAt: null,
          pendingSend: null,
        };

        if (state.workspaceDir !== workspaceDir) {
          throw new Error("会话工作目录不匹配。");
        }

        // 排队后读取最新状态，避免置顶、归档与输入保存互相覆盖。
        const next = change(state);
        validate(next, sessionId);
        if (next.workspaceDir !== workspaceDir) {
          throw new Error("会话工作目录不匹配。");
        }

        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        const temporaryPath = `${filename}.${randomUUID()}.tmp`;
        const file = await fs.open(temporaryPath, "wx", 0o600);

        try {
          try {
            await file.writeFile(JSON.stringify(next) + "\n", "utf8");
            await file.sync();
          } finally {
            await file.close();
          }

          // 完整写入并同步后替换，失败时保留旧状态。
          await fs.rename(temporaryPath, filename);
        } finally {
          await fs.rm(temporaryPath, { force: true });
        }

        return next;
      },
    );

    // 队尾总是结束，某次失败不会阻断后续更新。
    const settled = result.then(
      () => {},
      () => {},
    );
    pending.set(sessionId, settled);
    settled.then(() => {
      if (pending.get(sessionId) === settled) pending.delete(sessionId);
    });

    return result;
  }

  async function registerSession(sessionId, workspaceDir, source, model) {
    // 只保存实际选择的标识；不复制密钥、地址或完整模型对象。
    const registration = {
      source,
      model: { provider: model?.provider, modelId: model?.modelId },
    };
    validateRegistration(registration);

    return update(sessionId, workspaceDir, (state) => ({
      ...state,
      registration: {
        ...registration,
        // 曾经存在真实历史的会话，不能退回成可重建的空会话。
        source: state.registration?.source === "history" ? "history" : source,
      },
    }));
  }

  async function saveDraft(
    sessionId,
    workspaceDir,
    text,
    expectedRevision,
    readRegistration,
  ) {
    if (typeof text !== "string" || !isRevision(expectedRevision)) {
      throw new Error("输入草稿或版本无效。");
    }

    if (
      readRegistration !== undefined &&
      typeof readRegistration !== "function"
    ) {
      throw new Error("会话登记读取方法无效。");
    }

    return update(sessionId, workspaceDir, (state) => {
      if (state.draft.revision !== expectedRevision) {
        throw new Error("输入草稿版本已变化，请重新读取后再保存。");
      }

      // 到达写入队列时才读取，避免排队期间的旧模型覆盖实际选择。
      const registration = readRegistration?.();
      let nextRegistration = state.registration;
      if (registration !== undefined) {
        validateRegistration(registration);
        if (registration.workspaceDir !== workspaceDir) {
          throw new Error("会话恢复登记的工作目录不匹配。");
        }
        nextRegistration = {
          source:
            state.registration?.source === "history"
              ? "history"
              : registration.source,
          model: {
            provider: registration.model.provider,
            modelId: registration.model.modelId,
          },
        };
      }

      return {
        ...state,
        // 空字符串也是明确保存，不能删除版本，否则旧输入可能重新写回。
        draft: { text, revision: expectedRevision + 1 },
        ...(nextRegistration === undefined
          ? {}
          : { registration: nextRegistration }),
      };
    });
  }

  async function consumeDraft(sessionId, workspaceDir, text, expectedRevision) {
    if (
      typeof text !== "string" ||
      !text.trim() ||
      !isRevision(expectedRevision)
    ) {
      throw new Error("发送原文或输入版本无效。");
    }

    return update(sessionId, workspaceDir, (state) => {
      if (
        state.draft.revision !== expectedRevision ||
        state.draft.text !== text
      ) {
        throw new Error("待发送输入已变化，请重新确认后再发送。");
      }
      if (state.pendingSend) {
        throw new Error("该会话有尚未确认的发送记录，请先处理。");
      }

      // 原文快照与清空版本一起落盘，不能拆成两次写入。
      return {
        ...state,
        draft: { text: "", revision: expectedRevision + 1 },
        pendingSend: {
          id: randomUUID(),
          text,
          draftRevision: expectedRevision,
        },
      };
    });
  }

  async function completeSend(sessionId, workspaceDir, sendId) {
    if (typeof sendId !== "string" || !sendId) {
      throw new Error("发送编号无效。");
    }

    return update(sessionId, workspaceDir, (state) => {
      if (state.pendingSend?.id !== sendId) {
        throw new Error("发送记录已变化，不能清理其他发送快照。");
      }

      // 仅在业务层确认正常完成或主动停止后调用，不触碰后续输入。
      return { ...state, pendingSend: null };
    });
  }

  return {
    load,
    list,
    update,
    registerSession,
    saveDraft,
    consumeDraft,
    completeSend,
  };
}

module.exports = { createSessionStateStore };
