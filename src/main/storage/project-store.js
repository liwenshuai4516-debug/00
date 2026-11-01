const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  readFile, realpath, stat, mkdir, writeFile, rename, rm,
} = require("node:fs/promises");

// 只保存项目元信息，不创建会话，也不修改工作目录中的文件。
function createProjectStore(storagePath) {
  async function list() {
    let text;

    try {
      text = await readFile(storagePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      return [];
    }

    const data = JSON.parse(text);
    if (!Array.isArray(data?.projects)) {
      throw new Error("项目列表格式无效。");
    }

    const ids = new Set();
    const directories = new Set();

    for (const project of data.projects) {
      if (
        typeof project?.id !== "string" || !project.id.trim() ||
        typeof project.name !== "string" || !project.name.trim() ||
        typeof project.workspaceDir !== "string" ||
        !path.isAbsolute(project.workspaceDir) ||
        ids.has(project.id) || directories.has(project.workspaceDir)
      ) {
        throw new Error("项目记录无效或重复。");
      }
      ids.add(project.id);
      directories.add(project.workspaceDir);
    }

    // 不逐个检查目录是否仍存在；暂时失效的项目也应保留在列表中。
    return data.projects;
  }

  // 添加与重命名共用原子写入，调用方通过 IPC 串行执行。
  async function save(projects) {
    await mkdir(path.dirname(storagePath), { recursive: true });
    const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ projects }) + "\n",
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      // 同目录替换，读取者不会看到尚未写完的 JSON。
      await rename(temporaryPath, storagePath);
    } finally {
      await rm(temporaryPath, { force: true });
    }

  }

  // 后续通过 IPC 的互斥入口调用，避免多个添加操作相互覆盖。
  async function add(workspaceDir) {
    if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) {
      throw new Error("项目目录必须是绝对路径。");
    }

    const root = await realpath(workspaceDir);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("项目目录必须指向文件夹。");
    }

    const projects = await list();
    const existing = projects.find((project) => project.workspaceDir === root);
    if (existing) return existing;

    const project = {
      id: randomUUID(),
      name: path.basename(root) || root,
      workspaceDir: root,
    };
    projects.push(project);

    await save(projects);

    return project;
  }

  async function renameProject(projectId, name) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目。");
    }
    if (typeof name !== "string" || !name.trim() || name.trim().length > 40) {
      throw new Error("项目名称请输入 1～40 个字符。");
    }

    const projects = await list();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("未找到该项目，请重新读取项目列表。");
    }

    const nextName = name.trim();
    if (project.name === nextName) return project;

    // 只改登记名称，不依赖目录仍存在，也不改编号和真实路径。
    project.name = nextName;
    await save(projects);
    return project;
  }

  return { list, add, rename: renameProject };
}

module.exports = { createProjectStore };
