const fs = require("node:fs");
const path = require("node:path");

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

  console.log(JSON.stringify({
    node: process.versions.node,
    playwright: require("@playwright/test/package.json").version,
    platform: process.platform,
    arch: process.arch,
    browserExecutable: executable,
  }));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});