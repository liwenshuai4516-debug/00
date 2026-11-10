// 打包准备：把独立 CLI 依赖的宿主实现复制到 resources/testing/ui/lib，
// 保持与 src/main 相同的相对结构，避免运行时依赖开发仓库。
const fs = require("node:fs");
const path = require("node:path");

const SHARED_MODULES = [
  "capabilities/ui-testing/workflow.mjs",
  "capabilities/ui-testing/coverage.mjs",
  "capabilities/ui-testing/project-context.mjs",
  "capabilities/ui-testing/login-session.mjs",
  "capabilities/ui-testing/runtime-paths.js",
  "storage/project-store.js",
];

function copySharedModules(repoRoot, runtimeDir) {
  const source = path.join(repoRoot, "src/main");
  const target = path.join(runtimeDir, "lib");
  for (const file of SHARED_MODULES) {
    const destination = path.join(target, file);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.copyFileSync(path.join(source, file), destination);
  }
  return target;
}

module.exports = { copySharedModules, SHARED_MODULES };
