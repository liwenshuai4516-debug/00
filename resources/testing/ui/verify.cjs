const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

process.env.PLAYWRIGHT_BROWSERS_PATH = path.join(__dirname, "browsers");

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number);

  if (major < 22 || (major === 22 && minor < 19)) {
    throw new Error("内置 Node.js 必须至少为 22.19.0。");
  }

  const { chromium } = require("playwright");
  const executable = chromium.executablePath();

  if (!fs.existsSync(executable)) {
    throw new Error(`缺少与内置 Playwright 匹配的浏览器：${executable}`);
  }

  // 实际启动后关闭，不访问业务页面。
  const browser = await chromium.launch({ headless: true });
  await browser.close();

  // browser-use 运行时随浏览器一起核验，避免只检查 Node 侧就宣称环境可用。
  const upstream = JSON.parse(fs.readFileSync(path.join(__dirname, "browser-use/upstream.json"), "utf8"));
  const python = path.join(__dirname, "browser-use/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  if (!fs.existsSync(python)) {
    throw new Error(`缺少 browser-use Python 运行时：${python}；请先按 browser-use-runtime-gaps.md 构建并安装固定版本。`);
  }
  const probe = spawnSync(python, ["-c",
    "import json,sys,importlib.metadata as m; print(json.dumps({'python': sys.version.split()[0], 'platform': sys.platform, 'browserUse': m.version('browser-use')}))",
  ], { encoding: "utf8", timeout: 30_000 });
  if (probe.error) throw probe.error;
  if (probe.status !== 0) {
    throw new Error(`browser-use Python 运行时无法启动：${(probe.stderr || "").trim() || `退出码 ${probe.status}`}`);
  }
  let runtimeInfo;
  try {
    runtimeInfo = JSON.parse(probe.stdout.trim());
  } catch {
    throw new Error(`browser-use Python 运行时返回无效信息：${probe.stdout.trim().slice(0, 200)}`);
  }
  if (runtimeInfo.platform !== process.platform) {
    throw new Error(`browser-use Python 运行时平台不匹配：${runtimeInfo.platform} ≠ ${process.platform}。`);
  }
  const [pythonMajor, pythonMinor] = String(runtimeInfo.python).split(".").map(Number);
  if (pythonMajor !== 3 || !(pythonMinor >= 11)) {
    throw new Error(`browser-use Python 版本不受支持：${runtimeInfo.python}；需要 3.11 及以上。`);
  }
  if (runtimeInfo.browserUse !== upstream.version) {
    throw new Error(`browser-use 版本不匹配：${runtimeInfo.browserUse} ≠ ${upstream.version}；请重新构建固定补丁版。`);
  }

  console.log(JSON.stringify({
    node: process.versions.node,
    playwright: require("@playwright/test/package.json").version,
    platform: process.platform,
    arch: process.arch,
    browserExecutable: executable,
    python: runtimeInfo.python,
    browserUse: runtimeInfo.browserUse,
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});