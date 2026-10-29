const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  readFileSync,
  mkdirSync,
  openSync,
  writeFileSync,
  fsyncSync,
  closeSync,
  renameSync,
  rmSync,
} = require("node:fs");

// 只负责草稿快照的读写，不修改工作区文件，也不调用模型。
function createProposalStorage(directory) {
  function getFilename(sessionId) {
    // 会话编号用于文件名，禁止路径分隔符和目录跳转。
    if (
      typeof sessionId !== "string" ||
      !/^[a-zA-Z0-9_-]{1,128}$/.test(sessionId)
    ) {
      throw new Error("无效的会话编号。");
    }

    return path.join(directory, `${sessionId}.json`);
  }

  function validate(data, sessionId) {
    if (
      data?.version !== 1 ||
      data.sessionId !== sessionId ||
      !Array.isArray(data.proposals) ||
      data.proposals.some((proposal) =>
        !proposal ||
        typeof proposal !== "object" ||
        Array.isArray(proposal) ||
        proposal.sessionId !== sessionId,
      )
    ) {
      throw new Error("草稿记录格式错误或会话归属不匹配。");
    }
  }

  function load(sessionId) {
    const filename = getFilename(sessionId);
    let source;

    try {
      source = readFileSync(filename, "utf8");
    } catch (error) {
      // 首次使用时允许不存在；其他读取错误必须报告。
      if (error.code === "ENOENT") return [];
      throw error;
    }

    let data;

    try {
      data = JSON.parse(source);
    } catch (error) {
      throw new Error(`草稿记录损坏：${sessionId}。`, {
        cause: error,
      });
    }

    validate(data, sessionId);
    return data.proposals;
  }

  function save(sessionId, proposals) {
    const filename = getFilename(sessionId);
    const data = { version: 1, sessionId, proposals };

    validate(data, sessionId);
    const source = JSON.stringify(data);

    mkdirSync(directory, {
      recursive: true,
      mode: 0o700,
    });

    const temporaryPath = `${filename}.${randomUUID()}.tmp`;
    const file = openSync(temporaryPath, "wx", 0o600);
    let replaced = false;

    try {
      try {
        writeFileSync(file, source, "utf8");
        fsyncSync(file);
      } finally {
        closeSync(file);
      }

      // 新快照完整写入后，再替换旧快照。
      renameSync(temporaryPath, filename);
      replaced = true;
    } finally {
      // 写入或替换失败时，清理本次创建的临时文件。
      if (!replaced) {
        rmSync(temporaryPath, { force: true });
      }
    }
  }

  return { load, save };
}

module.exports = { createProposalStorage };