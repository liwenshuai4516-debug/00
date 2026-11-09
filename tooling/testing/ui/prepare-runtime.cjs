const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { copySharedModules } = require("./shared-runtime.cjs");

const projectRoot = path.resolve(__dirname, "../../..");
const runtimeDir = path.join(projectRoot, "resources/testing/ui");

function run(executable, args, options = {}) {
  const result = spawnSync(executable, args, {
    stdio: "inherit",
    ...options,
  });

  if (result.error) throw result.error;

  if (result.status !== 0) {
    throw new Error(`运行环境准备失败，退出码：${result.status}`);
  }
}

function main() {
  const suppliedNode = process.argv[2];

  if (!suppliedNode) {
    throw new Error("请提供官方 Node.js 可执行文件的绝对路径。");
  }

  const sourceNode = fs.realpathSync(suppliedNode);
  const inspected = spawnSync(
    sourceNode,
    [
      "-p",
      "JSON.stringify({platform:process.platform,arch:process.arch})",
    ],
    { encoding: "utf8" },
  );

  if (inspected.error) throw inspected.error;
  if (inspected.status !== 0) throw new Error("无法运行指定的 Node.js。");

  const target = JSON.parse(inspected.stdout);

  if (target.platform !== process.platform || target.arch !== process.arch) {
    throw new Error("首版需要在目标平台及对应 CPU 架构上准备运行环境。");
  }

  const cli = path.join(
    runtimeDir,
    "node_modules/@playwright/test/cli.js",
  );

  fs.accessSync(cli);

  const binDir = path.join(runtimeDir, "bin");
  fs.mkdirSync(binDir, { recursive: true });

  const nodeFile = path.join(
    binDir,
    process.platform === "win32" ? "node.exe" : "node",
  );

  if (sourceNode !== path.resolve(nodeFile)) {
    fs.copyFileSync(sourceNode, nodeFile);
  }

  if (process.platform !== "win32") {
    fs.chmodSync(nodeFile, 0o755);
  }

  run(nodeFile, [cli, "install", "chromium"], {
    cwd: runtimeDir,
    env: {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: path.join(runtimeDir, "browsers"),
    },
  });

  copySharedModules(projectRoot, runtimeDir);

  run(nodeFile, [path.join(runtimeDir, "verify.cjs")], {
    cwd: runtimeDir,
  });
}

try {
  main();
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}