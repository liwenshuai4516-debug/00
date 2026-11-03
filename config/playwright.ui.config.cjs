const path = require("node:path");
const { defineConfig } = require("@playwright/test");

const runDir = process.env.QA_UI_RUN_DIR;
if (!runDir) {
  throw new Error("请通过 npm run ui:case -- <case-id> 执行。");
}

module.exports = defineConfig({
  testDir: path.resolve(__dirname, "../qa/ui/cases"),
  testMatch: "**/*.spec.cjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,
  globalTimeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  outputDir: path.join(runDir, "artifacts"),
  reporter: [
    ["json", { outputFile: path.join(runDir, "results.json") }],
    ["html", {
      outputFolder: path.join(runDir, "html"),
      open: "never",
    }],
  ],
  use: {
    browserName: "chromium",
    headless: true,
    viewport: { width: 1280, height: 720 },
    trace: "on",
    screenshot: "only-on-failure",
  },
});
