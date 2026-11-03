const { chromium } = require("@playwright/test");
const { writeFile, chmod } = require("node:fs/promises");

let browser;
(async () => {
  const target = new URL(process.argv[2]);
  browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();
  browser.on("disconnected", () => process.exit(0));
  process.on("disconnect", () => browser.close());
  process.on("message", async (message) => {
    if (message.action === "close") {
      await browser.close();
      return;
    }
    if (message.action !== "save") return;
    try {
      if (new URL(page.url()).origin !== target.origin) {
        throw new Error("请先回到目标站点，再交接登录态。");
      }
      const state = await context.storageState({ indexedDB: true });
      state.origins = state.origins.filter((item) => item.origin === target.origin);
      state.cookies = state.cookies.filter((cookie) => {
        const domain = cookie.domain.replace(/^\./, "");
        return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
      });
      await writeFile(message.file, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await chmod(message.file, 0o600);
      process.send({ status: "saved" });
      await browser.close();
    } catch (error) {
      process.send({ status: "error", message: error.message });
    }
  });
  await page.goto(target.href);
  process.send({ status: "ready" });
})().catch(async () => {
  if (process.connected) process.send({ status: "error", message: "可见登录窗口启动失败。" });
  await browser?.close();
  process.exit(1);
});
