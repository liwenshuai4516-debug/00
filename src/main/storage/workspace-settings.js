const path = require("node:path");
const {
  realpath,
  stat,
  readFile,
  mkdir,
  writeFile,
  rename,
  rm,
} = require("node:fs/promises");
const { randomUUID } = require("node:crypto");

// 目录选择单独保存，不改写 .env，也不修改会话文件。
function createWorkspaceSettings(settingsPath, defaultWorkspaceDir) {
  async function normalize(workspaceDir) {
    if (
      typeof workspaceDir !== "string" ||
      !path.isAbsolute(workspaceDir)
    ) {
      throw new Error("工作目录必须是绝对路径。");
    }

    const root = await realpath(workspaceDir);

    if (!(await stat(root)).isDirectory()) {
      throw new Error("工作目录必须指向文件夹。");
    }

    return root;
  }

  async function load() {
    let text;

    try {
      text = await readFile(settingsPath, "utf8");
    } catch (error) {
      // 只有尚未保存过选择时，才使用启动配置中的默认目录。
      if (error.code !== "ENOENT") throw error;
      return normalize(defaultWorkspaceDir);
    }

    const settings = JSON.parse(text);
    return normalize(settings?.workspaceDir);
  }

  async function save(workspaceDir) {
    const root = await normalize(workspaceDir);
    await mkdir(path.dirname(settingsPath), { recursive: true });

    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ workspaceDir: root }) + "\n",
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );

      // 同目录替换配置，避免直接覆盖时留下半份 JSON。
      await rename(temporaryPath, settingsPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

    return root;
  }

  return { load, save };
}

module.exports = { createWorkspaceSettings };