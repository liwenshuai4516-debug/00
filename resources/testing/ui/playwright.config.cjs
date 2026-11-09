const path = require("node:path");
const { defineConfig } = require("@playwright/test");

const casesDir = process.env.QA_UI_CASES_DIR;
const outputDir = process.env.QA_UI_OUTPUT_DIR;

if (!casesDir || !outputDir) {
  throw new Error("缺少宿主提供的测试目录或输出目录。");
}

module.exports = defineConfig({
  testDir: casesDir,
  testMatch: "**/*.spec.cjs",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 30_000,

  globalTimeout: 600_000,

  expect: {
    timeout: 10_000,
  },

  outputDir: path.join(outputDir, "artifacts"),

  reporter: [
    ["json", {
      outputFile: path.join(outputDir, "results.json"),
    }],
    ["html", {
      outputFolder: path.join(outputDir, "html"),
      open: "never",
    }],
  ],

  projects: [
    {
      name: "chromium",
      use: {
        browserName: "chromium",
        headless: process.env.QA_UI_HEADED !== "1",
        storageState: process.env.QA_UI_STORAGE_STATE || undefined,
        viewport: { width: 1280, height: 720 },
        // trace 的 context-options 会保存 storageState 内容；带登录态时必须关闭。
        trace: process.env.QA_UI_STORAGE_STATE ? "off"
          : { mode: "on", snapshots: false, sources: false },
        screenshot: "only-on-failure",
      },
    },
  ],
});
