const path = require("node:path");
const fs = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

function validatePromptSettings(value) {
  if (
    value?.version !== 1 ||
    !Number.isSafeInteger(value.revision) || value.revision < 0 ||
    typeof value.testAgentPrompt !== "string" ||
    !value.testAgentPrompt.trim() ||
    value.testAgentPrompt.length > 16000 ||
    value.testAgentPrompt.includes("\0")
  ) {
    throw new Error("提示词配置无效：正文不能为空，最多 16000 个字符，且不能包含空字节。");
  }
}

function createPromptSettingsStore(filename, readDefaultPrompt) {
  let pending = Promise.resolve();

  async function readStored() {
    let text;
    try {
      text = await fs.readFile(filename, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // 只有文件不存在时使用内置默认；损坏配置不能静默重置。
      const defaults = {
        version: 1,
        revision: 0,
        testAgentPrompt: await readDefaultPrompt(),
      };
      validatePromptSettings(defaults);
      return defaults;
    }

    let settings;
    try {
      settings = JSON.parse(text);
    } catch (error) {
      throw new Error("提示词配置文件损坏，请保留原文件并检查。", { cause: error });
    }
    validatePromptSettings(settings);
    return settings;
  }

  async function read() {
    await pending;
    return readStored();
  }

  function save(testAgentPrompt, expectedRevision) {
    // 比较版本与保存必须处于同一队列，避免旧页面覆盖新配置。
    const operation = pending.then(async () => {
      validatePromptSettings({ version: 1, revision: expectedRevision, testAgentPrompt });
      const current = await readStored();
      if (current.revision !== expectedRevision) {
        throw new Error("提示词版本已变化，请先备份当前编辑内容，再重新读取配置。");
      }
      const next = {
        version: 1,
        revision: current.revision + 1,
        testAgentPrompt,
      };
      validatePromptSettings(next);
      await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
      const temporary = `${filename}.${randomUUID()}.tmp`;
      const file = await fs.open(temporary, "wx", 0o600);
      try {
        try {
          await file.writeFile(JSON.stringify(next) + "\n", "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
        // 同目录原子替换；写入失败时保留之前的完整配置。
        await fs.rename(temporary, filename);
      } finally {
        await fs.rm(temporary, { force: true });
      }
      return next;
    });

    // 某次失败不能让队列永久处于拒绝状态。
    pending = operation.then(() => {}, () => {});
    return operation;
  }

  return { read, save };
}

module.exports = { createPromptSettingsStore, validatePromptSettings };