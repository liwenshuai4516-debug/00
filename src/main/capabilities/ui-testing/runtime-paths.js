const path = require("node:path");

function resolveUiTestingRuntime(app, projectRoot, options = {}) {
  const resourcesPath = options.resourcesPath ?? process.resourcesPath;
  const directory = app.isPackaged
    ? path.join(resourcesPath, "testing/ui")
    : path.join(projectRoot, "resources/testing/ui");

  return {
    directory,
    projectConfig: path.join(projectRoot, "config/projects.local.json"),
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
    browserPython: path.join(directory, "browser-use/.venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python"),
    skill: path.join(directory, "skills/qa-ui-basic/SKILL.md"),
    designSkill: path.join(directory, "skills/qa-ui-case-design/SKILL.md"),
    executeSkill: path.join(directory, "skills/qa-ui-execute/SKILL.md"),
    assertionSkill: path.join(directory, "skills/qa-ui-assertion/SKILL.md"),
    reportSkill: path.join(path.dirname(directory), "reporting/SKILL.md"),
  };
}

module.exports = { resolveUiTestingRuntime };
