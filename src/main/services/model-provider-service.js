const { mkdir, writeFile } = require("node:fs/promises");
const path = require("node:path");

function createModelProviderService(openFile, readAgentDir = async () =>
  (await import("@mariozechner/pi-coding-agent")).getAgentDir()) {
  async function readConfiguration() {
    return { modelsPath: path.join(await readAgentDir(), "models.json") };
  }

  async function openConfiguration() {
    const { modelsPath } = await readConfiguration();
    await mkdir(path.dirname(modelsPath), { recursive: true });
    try {
      // 仅首次创建空配置；已有文件和凭据不读取、不覆盖、不回填页面。
      await writeFile(modelsPath, '{\n  "providers": {}\n}\n', { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const error = await openFile(modelsPath);
    if (error) throw new Error("无法打开 models.json，请使用文本编辑器打开所示路径。");
  }

  return { readConfiguration, openConfiguration };
}

module.exports = { createModelProviderService };
