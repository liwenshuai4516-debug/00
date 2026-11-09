// 独立 CLI 与打包资源共用同一套宿主实现：开发仓库直接引用 src/main，
// 打包后引用 prepare-runtime 复制到 lib/ 的只读副本，避免依赖仓库相对路径。
const fs = require("node:fs");
const path = require("node:path");

const bundled = path.join(__dirname, "lib");
const packaged = fs.existsSync(path.join(bundled, "capabilities/ui-testing/workflow.mjs"));
const root = packaged ? bundled : path.resolve(__dirname, "../../../src/main");

module.exports = {
  packaged,
  root,
  appResources: path.resolve(__dirname, "../.."),
  projectStore: path.join(root, "storage/project-store.js"),
  runtimePaths: path.join(root, "capabilities/ui-testing/runtime-paths.js"),
  workflow: path.join(root, "capabilities/ui-testing/workflow.mjs"),
};
