const { mkdir, rename, writeFile } = require("node:fs/promises");
const { readFileSync } = require("node:fs");
const path = require("node:path");

// 应用层工具权限模式；Pi 本身没有内建审批器，工具调用由官方 tool_call 扩展门禁。
const MODES = [
  {
    id: "ask",
    label: "每次确认",
    description: "读取、搜索类工具直接执行；写入、命令、登录和录制等工具每次弹窗确认。",
  },
  {
    id: "read-only",
    label: "只读",
    description: "阻止写入、命令、登录和录制等工具；读取、搜索和项目检查仍可使用。",
  },
  {
    id: "full-access",
    label: "完全权限",
    description: "所有工具直接执行，不再确认；模型提示词同步为已授权，不再按未授权只做只读。只在明确信任当前任务时使用。",
    risk: true,
  },
];
const MODE_IDS = new Set(MODES.map((mode) => mode.id));
const DEFAULT_MODE = "ask";
const STORAGE_VERSION = 2;
const SCOPES = new Set(["session", "workspace", "default"]);

function validMode(value) {
  return typeof value === "string" && MODE_IDS.has(value);
}

function readInitialState(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    // 兼容旧的全局单模式文件；首次保存时写成 v2。
    if (parsed?.version === 1 && validMode(parsed.mode)) {
      return { defaultMode: parsed.mode, sessions: {}, workspaces: {} };
    }
    const defaultMode = validMode(parsed?.defaultMode)
      ? parsed.defaultMode
      : validMode(parsed?.mode)
        ? parsed.mode
        : DEFAULT_MODE;
    const sessions = {};
    if (parsed?.sessions && typeof parsed.sessions === "object" && !Array.isArray(parsed.sessions)) {
      for (const [sessionId, mode] of Object.entries(parsed.sessions)) {
        if (typeof sessionId === "string" && sessionId && validMode(mode)) sessions[sessionId] = mode;
      }
    }
    const workspaces = {};
    if (parsed?.workspaces && typeof parsed.workspaces === "object" && !Array.isArray(parsed.workspaces)) {
      for (const [workspace, mode] of Object.entries(parsed.workspaces)) {
        if (typeof workspace === "string" && workspace && validMode(mode)) workspaces[workspace] = mode;
      }
    }
    return { defaultMode, sessions, workspaces };
  } catch {
    // 文件缺失或损坏时回到安全默认；损坏文件不自动覆盖，等用户显式保存。
    return { defaultMode: DEFAULT_MODE, sessions: {}, workspaces: {} };
  }
}

function createPermissionService(file) {
  let state = readInitialState(file);

  function settings(context = {}) {
    const sessionId = typeof context.sessionId === "string" ? context.sessionId : "";
    const workspace = typeof context.workspace === "string" ? context.workspace : "";
    const sessionMode = sessionId ? state.sessions[sessionId] : undefined;
    const workspaceMode = workspace ? state.workspaces[workspace] : undefined;
    const mode = sessionMode ?? workspaceMode ?? state.defaultMode;
    return {
      mode,
      scope: sessionMode ? "session" : workspaceMode ? "workspace" : "default",
      defaultMode: state.defaultMode,
      options: MODES.map((item) => ({ ...item })),
    };
  }

  function currentMode(context = {}) {
    return settings(context).mode;
  }

  async function save(input) {
    // 旧调用 save("mode") 仍按新会话默认保存，避免未更新的调用方直接失败。
    const mode = typeof input === "string" ? input : input?.mode;
    const scope = typeof input === "string" ? "default" : input?.scope ?? "session";
    if (!validMode(mode)) throw new Error("权限模式无效。");
    if (!SCOPES.has(scope)) throw new Error("权限范围无效。");

    const sessionId = typeof input?.sessionId === "string" ? input.sessionId : "";
    const workspace = typeof input?.workspace === "string" ? input.workspace : "";
    if (scope === "session" && !sessionId) throw new Error("未取得当前会话，无法保存会话权限。");
    if (scope === "workspace" && !workspace) throw new Error("未取得当前项目工作区，无法保存项目权限。");

    const next = {
      defaultMode: state.defaultMode,
      sessions: { ...state.sessions },
      workspaces: { ...state.workspaces },
    };
    if (scope === "default") {
      next.defaultMode = mode;
    } else if (scope === "workspace") {
      next.workspaces[workspace] = mode;
      // 项目范围应覆盖当前会话；清掉当前会话的旧覆盖，否则选择项目范围不会生效。
      if (sessionId) delete next.sessions[sessionId];
    } else {
      next.sessions[sessionId] = mode;
    }

    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(
      temporary,
      `${JSON.stringify({ version: STORAGE_VERSION, ...next }, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, file);
    state = next;
    return settings({ sessionId, workspace });
  }

  return { settings, currentMode, save };
}

module.exports = { createPermissionService, PERMISSION_MODES: MODES };
