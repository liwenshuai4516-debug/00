const path = require("node:path");

function resolveUiTestingRuntime(app, projectRoot) {
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, "testing/ui")
    : path.join(projectRoot, "resources/testing/ui");

  return {
    directory,
    node: path.join(
      directory,
      "bin",
      process.platform === "win32" ? "node.exe" : "node",
    ),
    modules: path.join(directory, "node_modules"),
    browsers: path.join(directory, "browsers"),
    testCli: path.join(
      directory,
      "node_modules/@playwright/test/cli.js",
    ),
    config: path.join(directory, "playwright.config.cjs"),
    verify: path.join(directory, "verify.cjs"),
    login: path.join(directory, "login.cjs"),
    runner: path.join(directory, "run.cjs"),
    skill: path.join(directory, "skills/qa-ui-basic/SKILL.md"),
  };
}

module.exports = { resolveUiTestingRuntime };
