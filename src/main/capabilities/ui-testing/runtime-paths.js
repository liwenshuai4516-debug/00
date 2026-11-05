const path = require("node:path");

function resolveUiTestingRuntime(app, projectRoot) {
  const directory = app.isPackaged
    ? path.join(process.resourcesPath, "testing/ui")
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
    skill: path.join(directory, "skills/qa-ui-basic/SKILL.md"),
    intentSkill: path.join(directory, "skills/qa-ui-intent/SKILL.md"),
    recordSkill: path.join(directory, "skills/qa-ui-record/SKILL.md"),
    executeSkill: path.join(directory, "skills/qa-ui-execute/SKILL.md"),
    assertionSkill: path.join(directory, "skills/qa-ui-assertion/SKILL.md"),
    reportSkill: path.join(path.dirname(directory), "reporting/SKILL.md"),
  };
}

module.exports = { resolveUiTestingRuntime };
