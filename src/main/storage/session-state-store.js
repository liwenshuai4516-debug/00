const path = require("node:path");
const { randomUUID } = require("node:crypto");
const fs = require("node:fs/promises");

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

  // change 仅供主进程传入同步更新函数，不能直接暴露给页面。
  async function update(sessionId, workspaceDir, change) {
    const filename = getFilename(sessionId);
    if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) {
      throw new Error("工作目录必须是绝对路径。");
    }

    const result = (pending.get(sessionId) ?? Promise.resolve()).then(async () => {
      const current = await read(sessionId, filename);
      const state = current ?? {
        version: 1,
        sessionId,
        workspaceDir,
        draft: { text: "", revision: 0 },
        pinnedAt: null,
        archivedAt: null,
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
    });

    // 队尾总是结束，某次失败不会阻断后续更新。
    const settled = result.then(() => {}, () => {});
    pending.set(sessionId, settled);
    settled.then(() => {
      if (pending.get(sessionId) === settled) pending.delete(sessionId);
    });

    return result;
  }

  async function saveDraft(sessionId, workspaceDir, text, expectedRevision) {
    if (typeof text !== "string" || !isRevision(expectedRevision)) {
      throw new Error("输入草稿或版本无效。");
    }

    return update(sessionId, workspaceDir, (state) => {
      if (state.draft.revision !== expectedRevision) {
        throw new Error("输入草稿版本已变化，请重新读取后再保存。");
      }

      return {
        ...state,
        // 空字符串也是明确保存，不能删除版本，否则旧输入可能重新写回。
        draft: { text, revision: expectedRevision + 1 },
      };
    });
  }

  return { load, update, saveDraft };
}

module.exports = { createSessionStateStore };