const path = require("node:path");
const { randomUUID } = require("node:crypto");
const {
  readFile,
  realpath,
  stat,
  mkdir,
  writeFile,
  rename,
  link,
  rm,
} = require("node:fs/promises");

// 保存项目元信息和本机前置配置，不创建会话，也不修改工作目录中的文件。
function createProjectStore(storagePath, legacyStoragePath) {
  async function readProjects() {
    let text;
    let fromLegacy = false;

    try {
      text = await readFile(storagePath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!legacyStoragePath) return [];
      try {
        text = await readFile(legacyStoragePath, "utf8");
        fromLegacy = true;
      } catch (legacyError) {
        if (legacyError.code !== "ENOENT") throw legacyError;
        return [];
      }
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 原始 JSON 错误可能携带账号密码片段，不能传回页面或日志。
      throw new Error("项目配置文件格式无效，请保留原文件并检查 JSON。");
    }
    if (!Array.isArray(data?.projects)) {
      throw new Error("项目列表格式无效。");
    }

    const ids = new Set();
    const directories = new Set();

    for (const project of data.projects) {
      if (
        typeof project?.id !== "string" ||
        !project.id.trim() ||
        typeof project.name !== "string" ||
        !project.name.trim() ||
        typeof project.workspaceDir !== "string" ||
        !path.isAbsolute(project.workspaceDir) ||
        ids.has(project.id) ||
        directories.has(project.workspaceDir)
      ) {
        throw new Error("项目记录无效或重复。");
      }
      ids.add(project.id);
      directories.add(project.workspaceDir);
    }

    if (fromLegacy) {
      try {
        // 校验完成后才迁移；排他发布，避免覆盖同时创建的本地配置。
        await save(data.projects, true);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        return readProjects();
      }
    }

    // 不逐个检查目录是否仍存在；暂时失效的项目也应保留在列表中。
    return data.projects;
  }

  // 页面只接收登记信息，新增配置不能随列表、添加或重命名回填。
  function toSummary(project) {
    return { id: project.id, name: project.name, workspaceDir: project.workspaceDir };
  }

  // 环境列表只回传地址、账号和密码是否已配置，绝不回传密码原文。
  function toEnvironment(project) {
    return {
      id: project.id,
      name: project.name,
      workspaceDir: project.workspaceDir,
      address: typeof project.address === "string" ? project.address : "",
      account: typeof project.account === "string" ? project.account : "",
      passwordConfigured:
        typeof project.password === "string" && project.password.length > 0,
    };
  }

  function normalizeAddress(input) {
    if (typeof input !== "string") {
      throw new Error("项目地址必须是字符串。");
    }
    const value = input.trim();
    if (value === "") return "";
    let url;
    try {
      url = new URL(value);
    } catch {
      throw new Error("项目地址配置无效，请填写 HTTP/HTTPS 地址。");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new Error(
        "项目地址配置无效：必须使用 HTTP/HTTPS，且不能包含账号密码。",
      );
    }
    return value;
  }

  async function listEnvironments() {
    return (await readProjects()).map(toEnvironment);
  }

  // 更新项目环境字段；password 缺省表示保持原密码，空字符串表示清除。
  async function updateData(projectId, input) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目。");
    }
    if (typeof input !== "object" || input === null || Array.isArray(input)) {
      throw new Error("项目环境数据无效。");
    }

    const projects = await readProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("未找到该项目，请重新读取项目环境。");
    }

    let changed = false;
    if (input.name !== undefined) {
      if (typeof input.name !== "string") {
        throw new Error("项目名称必须是字符串。");
      }
      const name = input.name.trim();
      if (!name || name.length > 40) {
        throw new Error("项目名称请输入 1～40 个字符。");
      }
      if (project.name !== name) {
        project.name = name;
        changed = true;
      }
    }
    if (input.address !== undefined) {
      const address = normalizeAddress(input.address);
      if (project.address !== address) {
        project.address = address;
        changed = true;
      }
    }
    if (input.account !== undefined) {
      if (typeof input.account !== "string") {
        throw new Error("账号必须是字符串。");
      }
      if (project.account !== input.account) {
        project.account = input.account;
        changed = true;
      }
    }
    if (Object.hasOwn(input, "password")) {
      if (typeof input.password !== "string") {
        throw new Error("密码必须是字符串。");
      }
      if (project.password !== input.password) {
        project.password = input.password;
        changed = true;
      }
    }

    if (changed) await save(projects);
    return toEnvironment(project);
  }

  // 只删除项目登记与环境字段，不触碰工作目录、会话或测试数据。
  async function remove(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目。");
    }
    const projects = await readProjects();
    const index = projects.findIndex((item) => item.id === projectId);
    if (index < 0) {
      throw new Error("未找到该项目，请重新读取项目环境。");
    }
    const [removed] = projects.splice(index, 1);
    await save(projects);
    return { id: removed.id, name: removed.name };
  }

  async function list() {
    return (await readProjects()).map(toSummary);
  }

  // 仅供主进程按需读取，不登记到 IPC、模型上下文或原生工具结果。
  async function readData(projectId) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目。");
    }
    const projects = await readProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("未找到该项目，请重新读取项目列表。");
    }
    for (const key of ["address", "account", "password"]) {
      if (project[key] !== undefined && typeof project[key] !== "string") {
        throw new Error("项目数据配置无效：地址、账号和密码必须为字符串。");
      }
    }
    const address = project.address ?? "";
    if (address) {
      let url;
      try {
        url = new URL(address);
      } catch {
        throw new Error("项目地址配置无效，请填写 HTTP/HTTPS 地址。");
      }
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("项目地址配置无效：必须使用 HTTP/HTTPS，且不能包含账号密码。");
      }
    }
    return {
      name: project.name,
      address,
      account: project.account ?? "",
      password: project.password ?? "",
    };
  }

  // 后续通过 IPC 的互斥入口调用，避免多个添加操作相互覆盖。
    // 添加与重命名共用原子写入，调用方通过 IPC 串行执行。
  async function save(projects, createOnly = false) {
    await mkdir(path.dirname(storagePath), { recursive: true });

    const temporaryPath = `${storagePath}.${randomUUID()}.tmp`;

    try {
      await writeFile(
        temporaryPath,
        JSON.stringify({ projects }) + "\n",
        { encoding: "utf8", mode: 0o600, flag: "wx" },
      );
      // 同目录替换，读取者不会看到尚未写完的 JSON。
      if (createOnly) {
        await link(temporaryPath, storagePath);
      } else {
        await rename(temporaryPath, storagePath);
      }
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
  async function add(workspaceDir) {
    if (typeof workspaceDir !== "string" || !path.isAbsolute(workspaceDir)) {
      throw new Error("项目目录必须是绝对路径。");
    }

    const root = await realpath(workspaceDir);
    if (!(await stat(root)).isDirectory()) {
      throw new Error("项目目录必须指向文件夹。");
    }

    const projects = await readProjects();
    const existing = projects.find((project) => project.workspaceDir === root);
    if (existing) return toSummary(existing);

    const project = {
      id: randomUUID(),
      name: path.basename(root) || root,
      workspaceDir: root,
      address: "",
      account: "",
      password: "",
    };
    projects.push(project);

    await save(projects);

    return toSummary(project);
  }

  async function renameProject(projectId, name) {
    if (typeof projectId !== "string" || !projectId.trim()) {
      throw new Error("请选择项目。");
    }
    if (typeof name !== "string" || !name.trim() || name.trim().length > 40) {
      throw new Error("项目名称请输入 1～40 个字符。");
    }

    const projects = await readProjects();
    const project = projects.find((item) => item.id === projectId);
    if (!project) {
      throw new Error("未找到该项目，请重新读取项目列表。");
    }

    const nextName = name.trim();
    if (project.name === nextName) return toSummary(project);

    // 只改登记名称，不依赖目录仍存在，也不改编号和真实路径。
    project.name = nextName;
    await save(projects);
    return toSummary(project);
  }

  return {
    list,
    add,
    rename: renameProject,
    readData,
    listEnvironments,
    updateData,
    remove,
  };
}

module.exports = { createProjectStore };
