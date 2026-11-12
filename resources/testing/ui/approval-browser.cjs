const fs = require("node:fs/promises");
const path = require("node:path");
const { expect } = require("@playwright/test");

function expand(value, variables) {
  return value.replace(/\{\{([a-zA-Z][a-zA-Z0-9]*)\}\}/g, (_, key) => {
    if (variables[key] === undefined) throw new Error(`缺少流程变量：${key}`);
    return String(variables[key]);
  });
}
function allowed(address, value) {
  const base = new URL(address), target = new URL(value);
  const prefix = base.pathname.replace(/\/$/, "");
  return base.origin === target.origin && !target.username && !target.password &&
    (!prefix || target.pathname === prefix || target.pathname.startsWith(prefix + "/"));
}
async function verify(page, checks, variables) {
  for (const check of checks) {
    const locator = page.locator(expand(check.selector, variables));
    if (check.kind === "value") await expect(locator).toHaveValue(expand(check.text, variables));
    else await expect(locator).toHaveText(expand(check.text, variables));
  }
}

// 每个节点一个隔离 context；凭据不进入模型或计划，执行时只消费宿主的私有状态。
async function visit(browser, plan, step, states, variables, operation, hooks = {}) {
  const actor = plan.actors.find(item => item.id === step.actorId);
  if (!actor || !states[actor.id]) throw new Error("缺少节点身份登录态。");
  const context = await browser.newContext({ storageState: states[actor.id] });
  const page = await context.newPage();
  const requests = [], pageErrors = [];
  page.on("response", async response => {
    if (requests.length < 20 && ["document", "xhr", "fetch"].includes(response.request().resourceType())) {
      const entry = { method: response.request().method(), pathname: new URL(response.url()).pathname, status: response.status() };
      requests.push(entry);
      if ((response.headers()["content-type"] ?? "").includes("application/json")) {
        try { const body = await response.json(); if (typeof body.code === "number") entry.businessCode = body.code; } catch { /* 不保留响应正文。 */ }
      }
    }
  });
  page.on("pageerror", error => { if (pageErrors.length < 5) pageErrors.push(error.name); });
  page.setDefaultTimeout(10000);
  await context.route("**/*", route => {
    const url = route.request().url();
    // 限定页面导航与业务请求；普通静态资源也只访问当前项目 origin。
    return (route.request().isNavigationRequest() ? allowed(plan.address, url) : new URL(url).origin === new URL(plan.address).origin) ? route.continue() : route.abort();
  });
  try {
    const target = expand(step.url, variables);
    hooks.phase?.("navigation");
    if (!allowed(plan.address, target)) throw new Error("审批页面超出项目范围。");
    await page.goto(target);
    if (new URL(page.url()).pathname !== new URL(target).pathname || new URL(page.url()).hash !== new URL(target).hash) throw new Error("节点路由不符。");
    hooks.phase?.("identity");
    await verify(page, [actor.identity], variables);
    if (operation === "inspect") {
      hooks.phase?.("record");
      if (!step.createsRecord) await verify(page, [plan.record], variables);
      hooks.phase?.("before");
      await verify(page, step.before, variables);
      hooks.phase?.("controls");
      const controls = await page.locator("button,input:not([type=password]),textarea,select,a,[role=button]").evaluateAll(elements =>
        elements.filter(el => el.type === "file" || el.getClientRects().length).slice(0, 100).map(el => ({
          tag: el.tagName, role: el.getAttribute("role"), id: el.id,
          name: el.getAttribute("aria-label") || el.innerText?.slice(0, 100) || el.getAttribute("placeholder"),
          type: el.getAttribute("type"), testId: el.getAttribute("data-testid"),
        })));
      await hooks.screenshot?.(page, "inspection");
      return { url: page.url(), controls, pageText: (await page.locator("body").innerText()).slice(0, 16000) };
    }
    if (operation === "execute") {
      hooks.phase?.("record");
      if (!step.createsRecord) await verify(page, [plan.record], variables);
      hooks.phase?.("before");
      await verify(page, step.before, variables);
      await hooks.screenshot?.(page, "initial");
      for (const [index, action] of step.actions.entries()) {
        hooks.phase?.("target", index);
        const locator = page.locator(expand(action.selector, variables));
        await expect(locator).toHaveCount(1);
        // 密码输入只能由宿主登录实现；页面数据不能要求模型填写凭据。
        if (await locator.getAttribute("type") === "password") throw new Error("审批动作不能填写密码。");
        hooks.phase?.("action", index);
        await hooks.intent?.(index, action);
        if (action.kind === "click") await locator.click();
        else if (action.kind === "fill") await locator.fill(expand(action.value, variables));
        else if (action.kind === "select") await locator.selectOption(expand(action.value, variables));
        else if (action.kind === "upload") await locator.setInputFiles(action.file);
        else throw new Error("未知审批动作。");
        if (!allowed(plan.address, page.url())) throw new Error("审批操作离开项目范围。");
        await hooks.action?.(index, action);
      }
    }
    if (step.capture) {
      hooks.phase?.("capture");
      if (step.capture.query) await page.waitForURL(url => Boolean(url.searchParams.get(step.capture.query)));
      else await expect(page.locator(expand(step.capture.selector, variables))).toHaveAttribute(step.capture.attribute, /.+/);
      const value = step.capture.query ? new URL(page.url()).searchParams.get(step.capture.query)
        : await page.locator(expand(step.capture.selector, variables)).getAttribute(step.capture.attribute);
      if (!value || !/^[a-zA-Z0-9_.:-]+$/.test(value)) throw new Error("业务记录标识未确认。");
      variables[step.capture.name] = value;
    }
    hooks.phase?.("after");
    await verify(page, [plan.record, ...step.after], variables);
    await hooks.screenshot?.(page, "business");
    return { url: page.url(), variables, pageText: (await page.locator("body").innerText()).slice(0, 16000) };
  } catch (error) {
    try { await hooks.screenshot?.(page, "failure"); } catch { /* 不用截图失败覆盖原节点结果。 */ }
    error.diagnostics = { pathname: new URL(page.url()).pathname, requests, pageErrors };
    error.pageText = await page.locator("body").innerText().then(text => text.slice(0, 16000)).catch(() => undefined);
    throw error;
  } finally { await context.close(); }
}

async function runPlan(browser, plan, testInfo, runId) {
  const states = JSON.parse(await fs.readFile(process.env.QA_UI_APPROVAL_STATES, "utf8"));
  const variables = { runId };
  const screenshot = async (page, name) => {
    const file = testInfo.outputPath(`${name}.png`);
    await page.screenshot({ path: file });
    await testInfo.attach(name, { path: file, contentType: "image/png" });
  };
  for (const [stepIndex, original] of plan.steps.entries()) {
    const step = structuredClone(original);
    for (const action of step.actions) {
      if (action.kind === "upload") action.file = path.resolve(process.env.QA_UI_WORKSPACE, action.file);
    }
    await visit(browser, plan, step, states, variables, "execute", {
      screenshot: async (page, name) => {
        await screenshot(page, `${step.id}-${name}`);
        if (stepIndex === 0 && name === "initial") await screenshot(page, "qa-initial-state");
        if (stepIndex === plan.steps.length - 1 && name === "business") {
          await screenshot(page, "qa-business-result");
          await screenshot(page, "qa-residue");
        }
      },
      intent: async (index, action) => {
        // 落盘在写入之前；中断后保留原批次，不自动重放。
        await fs.appendFile(testInfo.outputPath("approval-journal.jsonl"), JSON.stringify({ stepId: step.id, index, kind: action.kind, status: "intent" }) + "\n");
      },
    });
  }
  await testInfo.attach("approval-journal", { path: testInfo.outputPath("approval-journal.jsonl"), contentType: "application/x-ndjson" });
  return { status: "completed" };
}

if (require.main === module) {
  const { chromium } = require("@playwright/test");
  let browser, launching, wrote = false, settled = false, interrupted = false, stage = "browser-start", actionIndex;
  async function finish(result) {
    if (settled) return;
    settled = true;
    try { if (launching) browser = await launching; await browser?.close(); result.cleanupConfirmed = true; }
    catch { result.cleanupConfirmed = false; }
    if (process.connected) process.send(result, () => process.disconnect());
  }
  process.once("SIGTERM", () => { interrupted = true; void finish({ status: "unknown", reason: "审批已取消或超时，先核对原节点状态，禁止重放。" }); });
  process.once("message", async message => {
    try {
      launching = chromium.launch({ headless: true });
      browser = await launching;
      if (interrupted) return;
      const result = await visit(browser, message.plan, message.step, message.states, message.variables, message.operation, {
        phase: (value, index) => { stage = value; actionIndex = index; },
        screenshot: async (page, name) => page.screenshot({ path: path.join(message.output, `${name}.png`), fullPage: true }),
        intent: async (index, action) => {
          if (interrupted) throw new Error("审批已停止。");
          wrote = true;
          await fs.appendFile(path.join(message.output, "intents.jsonl"), JSON.stringify({ index, kind: action.kind }) + "\n");
        },
        action: async (index, action) => fs.appendFile(path.join(message.output, "actions.jsonl"), JSON.stringify({
          stepId: `${message.step.id}-${index}`, action: { [action.kind]: { selector: action.selector } }, result: [{ success: true }],
        }) + "\n"),
      });
      await finish({ status: "completed", ...result });
    } catch (error) {
      // Playwright 异常可能包含输入正文，不转发原始调用日志。
      await finish({ status: wrote ? "unknown" : "blocked",
        code: `${stage}-unconfirmed`, stage, actionIndex, diagnostics: error.diagnostics, pageText: error.pageText,
        reason: wrote ? "审批动作已开始，结果未确认；先 reconcile，禁止重放。" : "身份、初态或页面未满足；未开始节点动作。" });
    }
  });
  process.on("disconnect", () => browser?.close());
}
module.exports = { expand, allowed, verify, visit, runPlan };
