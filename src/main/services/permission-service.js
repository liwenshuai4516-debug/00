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
    description: "所有工具直接执行，不再确认。只在明确信任当前任务时使用。",
    risk: true,
  },
];
const MODE_IDS = new Set(MODES.map((mode) => mode.id));
const DEFAULT_MODE = "ask";

function readInitialMode(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8"));
    const mode = typeof parsed?.mode === "string" ? parsed.mode.trim() : "";
    return MODE_IDS.has(mode) ? mode : DEFAULT_MODE;
  } catch {
    // 文件缺失或损坏时回到安全默认；损坏文件不自动覆盖，等用户显式保存。
    return DEFAULT_MODE;
  }
}

function createPermissionService(file) {
  let mode = readInitialMode(file);

  function settings() {
    return {
      mode,
      options: MODES.map((item) => ({ ...item })),
    };
  }

  function currentMode() {
    return mode;
  }

  async function save(nextMode) {
    const value = typeof nextMode === "string" ? nextMode.trim() : "";
    if (!MODE_IDS.has(value)) throw new Error("权限模式无效。");
    await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ version: 1, mode: value }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
    mode = value;
    return settings();
  }

  return { settings, save, currentMode };
}

module.exports = { createPermissionService, PERMISSION_MODES: MODES };
