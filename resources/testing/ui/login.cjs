const { chromium } = require("@playwright/test");
const { writeFile, chmod } = require("node:fs/promises");

let browser;
(async () => {
  const target = new URL(process.argv[2]);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  browser.on("disconnected", () => process.exit(0));
  process.on("disconnect", () => browser.close());
  async function save(file) {
    if (new URL(page.url()).origin !== target.origin) throw new Error("origin-mismatch");
    const state = await context.storageState({ indexedDB: true });
    state.origins = state.origins.filter((item) => item.origin === target.origin);
    state.cookies = state.cookies.filter((cookie) => {
      const domain = cookie.domain.replace(/^\./, "");
      return target.hostname === domain || target.hostname.endsWith(`.${domain}`);
    });
    await writeFile(file, JSON.stringify(state), { mode: 0o600, flag: "wx" });
    await chmod(file, 0o600);
  }
  async function autoLogin(message) {
    const selectors = message.selectors ?? {};
    let stage = "page-ready", verificationCode = "identity-unconfirmed";
    const blocked = (code, reason) => ({ status: "manual-required", code, stage, reason });
    const password = page.locator(selectors.password || 'input[type="password"]').filter({ visible: true });
    const verified = async () => {
      let current;
      try { current = new URL(page.url()); } catch { return false; }
      if (current.origin !== target.origin) { verificationCode = "manual-authentication-required"; return false; }
      // 目标路由必须稳定；SPA 空壳可能短暂渲染身份区后又被守卫重定向到登录页。
      if (current.pathname !== target.pathname || current.hash !== target.hash) { verificationCode = "route-mismatch"; return false; }
      if (selectors.authenticated) {
        const identity = page.locator(selectors.authenticated);
        if (await identity.count() !== 1 || !await identity.isVisible()) { verificationCode = "identity-unconfirmed"; return false; }
        if (selectors.identityText && (await identity.innerText()).trim() !== selectors.identityText) { verificationCode = "identity-mismatch"; return false; }
        return true;
      }
      verificationCode = "login-unconfirmed";
      return await password.count() === 0;
    };
    try {
      // 首屏脚本可能稍后渲染表单；先等待明确登录控件或配置的身份探针。
      await Promise.race([
        password.first().waitFor({ state: "visible", timeout: 5000 }).catch(() => {}),
        selectors.authenticated ? page.locator(selectors.authenticated).waitFor({ state: "visible", timeout: 5000 }).catch(() => {}) : new Promise(() => {}),
      ]);
      // 等待路由稳定，避免把登录守卫前的空壳误判为已登录。
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      if (await password.count() === 0) {
        if (!await verified()) return blocked(verificationCode, "无法确认目标页面或身份，请处理重定向或配置身份标识。");
        return { status: "not-required", verification: selectors.authenticated ? "configured-marker" : "target-route-without-login-form" };
      }
      if (new URL(page.url()).origin !== target.origin) return blocked("manual-authentication-required", "跨站登录需要人工处理。");
      if (!message.credentials.account || !message.credentials.password) return blocked("credentials-missing", "项目账号或密码未配置。");
      if (await page.locator('input[autocomplete="one-time-code"],input[placeholder*="验证码"],input[name*="captcha" i]').filter({ visible: true }).count()) {
        return blocked("manual-authentication-required", "检测到验证码或动态认证，需要人工处理。");
      }
      stage = "form-identification";
      const account = page.locator(selectors.account || 'input[autocomplete="username"],input[name="username"],input[name="account"],input[type="email"],input[placeholder*="账号"],input[placeholder*="用户名"]').filter({ visible: true });
      const submit = selectors.submit ? page.locator(selectors.submit).filter({ visible: true })
        : page.getByRole("button", { name: /^\s*(登\s*录|登录系统|login|sign in)\s*$/i });
      if (await password.count() !== 1 || await account.count() !== 1 || await submit.count() !== 1) {
        return blocked("form-ambiguous", "无法唯一识别登录表单，请依据真实页面提供 selectors。");
      }
      const action = await password.evaluate((element) => element.form?.action || location.href);
      if (new URL(action, page.url()).origin !== target.origin) return blocked("manual-authentication-required", "登录表单提交到其他站点，需要人工核对。");
      // 凭据仅通过私有 IPC 进入此进程，不经过模型、工具结果或磁盘脚本。
      await context.route("**/*", (route) => new URL(route.request().url()).origin === target.origin ? route.continue() : route.abort());
      stage = "login-submit";
      await account.fill(message.credentials.account, { timeout: 5000 });
      await password.fill(message.credentials.password, { timeout: 5000 });
      await submit.click({ timeout: 5000 });
      await password.waitFor({ state: "hidden", timeout: 10000 });
      if (selectors.tenant && await page.locator(selectors.tenant.selector).isVisible()) {
        stage = "tenant-selection";
        await page.locator(selectors.tenant.selector).click({ timeout: 5000 });
        await page.locator(selectors.tenant.confirm).click({ timeout: 5000 });
      }
      stage = "target-route";
      await page.goto(target.href);
      stage = "identity";
      if (selectors.authenticated) await page.locator(selectors.authenticated).waitFor({ state: "visible", timeout: 10000 }).catch(() => {});
      else await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      if (!await verified()) return blocked(verificationCode, "登录后目标路由或身份未通过严格核验，不会重复提交。");
      stage = "storage-state";
      await save(message.file);
      return { status: "saved", verification: selectors.authenticated ? "configured-marker" : "target-route-without-login-form" };
    } catch {
      // Playwright 错误可能带输入值，禁止将原始错误发送给宿主。
      return blocked(stage === "tenant-selection" ? "tenant-incomplete" : "login-unconfirmed", "自动登录未通过验证；不会重复提交，请按失败阶段检查认证条件。");
    }
  }
  process.on("message", async (message) => {
    if (message.action === "close") { await browser.close(); return; }
    if (message.action === "auto") {
      const result = await autoLogin(message);
      process.send({ event: "auto-result", ...result });
      if (["saved", "not-required"].includes(result.status)) await browser.close();
      return;
    }
  });
  await page.goto(target.href);
  process.send({ status: "ready" });
})().catch(async () => {
  if (process.connected) process.send({ status: "error", message: "后台登录进程启动失败。" });
  await browser?.close();
  process.exit(1);
});
