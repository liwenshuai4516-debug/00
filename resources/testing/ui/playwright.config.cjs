const path = require("node:path");
const { defineConfig } = require("@playwright/test");

const casesDir = process.env.QA_UI_CASES_DIR;
const outputDir = process.env.QA_UI_OUTPUT_DIR;
const recording = process.env.QA_UI_PHASE === "record";

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

  // 官方录制通过暂停 seed 测试维持页面，不能套用正式批次时限。
  globalTimeout: recording ? 0 : 60_000,

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
        headless: true,
        viewport: { width: 1280, height: 720 },
        trace: "on",
        screenshot: "only-on-failure",
      },
    },
  ],
});