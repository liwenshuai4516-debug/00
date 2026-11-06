import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fork } from "node:child_process";
import { once } from "node:events";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const runtime = path.join(root, "resources/testing/ui");
const { chromium } = require(path.join(runtime, "node_modules/@playwright/test"));
const { startProbe } = require(path.join(runtime, "browser-use/bridge.cjs"));
const args = process.argv.slice(2);
let realModel = null;
let check = "all";
for (let index = 0; index < args.length; index += 2) {
  if (args[index] === "--model") realModel = args[index + 1];
  else if (args[index] === "--check") check = args[index + 1];
  else throw new Error("未知参数；支持 --model provider/model、--check all|init|error|explore|replay");
  if (!args[index + 1]) throw new Error("参数缺少值");
}
assert.ok(["all", "init", "error", "explore", "replay"].includes(check), "未知检查范围");
assert.ok(!realModel || realModel.includes("/"), "模型须为 provider/model");
assert.ok(check !== "explore" || realModel, "探索检查必须指定模型");
const selected = (stage) => check === "all" || check === stage;
const outputRoot = path.join(root, "qa/ui/browser-use-smoke");
await fs.mkdir(outputRoot, { recursive: true });
const output = await fs.mkdtemp(path.join(outputRoot, "run-"));
await fs.chmod(output, 0o700);
const privateDir = path.join(output, "private");
await fs.mkdir(privateDir, { mode: 0o700 });
const clicks = [];
let phase = "login";
const loginHtml = `<!doctype html><html lang="en"><body>
<form><label>Account<input autocomplete="username" name="account"></label>
<label>Password<input type="password"></label><button>Login</button></form>
<script>document.querySelector('form').onsubmit=async e=>{e.preventDefault();
await fetch('/session',{method:'POST'});localStorage.setItem('role','smoke-reviewer');location.href='/app';};</script>
</body></html>`;
const appHtml = `<!doctype html><html lang="en"><head><title>Browser use spike</title></head><body>
<h1>Accounts</h1><p data-testid="identity"></p><table><tbody>
<tr data-row="Alpha"><td>Alpha</td><td><button>Detail</button></td></tr>
<tr data-row="Beta"><td>Beta</td><td><button>Detail</button></td></tr>
</tbody></table><p role="status">No detail selected</p><script>
document.querySelector('[data-testid="identity"]').textContent=localStorage.getItem('role')==='smoke-reviewer'?'smoke-reviewer':'unknown';
document.querySelectorAll('button').forEach(b=>b.onclick=async()=>{
document.querySelector('[role="status"]').textContent='Loading';
const data=await(await fetch('/detail?id='+b.closest('tr').dataset.row)).json();
document.querySelector('[role="status"]').textContent=data.text;});</script></body></html>`;
const server = createServer((req, res) => {
  const url = new URL(req.url, "http://127.0.0.1");
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  if (url.pathname === "/session" && req.method === "POST") {
    res.setHeader("Set-Cookie", "probe=temporary-reviewer; HttpOnly; SameSite=Lax; Path=/");
    res.end("ok");
  } else if (url.pathname === "/login") res.end(loginHtml);
  else if (!req.headers.cookie?.includes("probe=temporary-reviewer")) {
    res.writeHead(302, { Location: "/login" }); res.end();
  } else if (url.pathname === "/detail") {
    clicks.push({ phase, id: url.searchParams.get("id") });
    setTimeout(() => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify({ text: `${url.searchParams.get("id")} · ready` })); }, 350);
  } else res.end(appHtml);
});
server.listen(0, "127.0.0.1");
await once(server, "listening");
const url = `http://127.0.0.1:${server.address().port}/app`;
const storageFile = path.join(privateDir, "state.json");
const summary = { startedAt: new Date().toISOString(), platform: `${process.platform}/${process.arch}`,
  model: realModel, scope: check, output, checks: {}, exceptions: [] };
let browser;
let login;

async function resolveModel(reference) {
  const { ModelRuntime } = await import("@mariozechner/pi-coding-agent");
  const models = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  const divider = reference.indexOf("/");
  const selected = models.getModel(reference.slice(0, divider), reference.slice(divider + 1));
  assert.ok(selected, "指定模型未登记");
  assert.equal(selected.api, "openai-completions", "小验证仅支持 OpenAI Chat Completions 兼容接口");
  assert.equal(models.isUsingOAuth(selected.provider), false, "本次不验证 OAuth");
  assert.equal(models.isUsingSubscription(selected.provider), false, "本次不验证订阅认证");
  const resolved = await models.getAuth(selected);
  assert.ok(resolved?.auth.apiKey, "指定模型没有可用 API Key");
  const endpoint = resolved.auth.baseUrl || selected.baseUrl;
  assert.ok(endpoint && new URL(endpoint).protocol === "https:", "必须使用所选模型明确配置的 HTTPS 地址");
  return { model: selected.id, api_key: resolved.auth.apiKey,
    base_url: endpoint,
    default_headers: { ...selected.headers, ...resolved.auth.headers } };
}

async function prepareLogin() {
  login = fork(path.join(runtime, "login.cjs"), [url], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const exit = once(login, "exit");
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("login-timeout")), 20000);
    login.on("message", (message) => {
      if (message.status === "ready") login.send({ action: "auto", file: storageFile,
        credentials: { account: "temporary-reviewer", password: "temporary-fixture-only" },
        selectors: { authenticated: '[data-testid="identity"]' } });
      if (message.event === "auto-result" || message.status === "error") { clearTimeout(timer); resolve(message); }
    });
    login.once("error", () => { clearTimeout(timer); reject(new Error("login-start-failed")); });
    login.once("exit", () => { clearTimeout(timer); reject(new Error("login-exited-without-result")); });
  });
  assert.equal(result.status, "saved", "现有后台登录没有导出状态");
  await exit;
  const state = JSON.parse(await fs.readFile(storageFile, "utf8"));
  assert.equal((await fs.stat(storageFile)).mode & 0o777, 0o600);
  return state;
}

async function probe(mode, state, model) {
  const directory = path.join(output, mode);
  await fs.mkdir(path.join(directory, "private"), { recursive: true, mode: 0o700 });
  const message = { type: "start", taskId: mode, mode, output: directory,
    chromium: chromium.executablePath(), url, storageState: state, model,
    // 用户已确认该内网模型应直连；其他模型沿用既有代理设置。
    directModelHost: model && realModel === "qwen3.8-flash-next/qwen3.8-flash-next" ? new URL(model.base_url).hostname : null,
    goal: `Open ${url}. Confirm identity smoke-reviewer. Click the Detail button in the Beta row exactly once. Observe the asynchronous status Beta · ready, then finish successfully. Do not click Alpha. Do not use coordinates, scripts, extraction, wait actions or any other website. Use one action per decision.` };
  const task = startProbe({ python: path.join(runtime, "browser-use/.venv/bin/python"), message,
    onEvent(event) {
      if (mode === "cancel-probe" && event.phase === "browser-ready") task.cancel();
    } });
  try { return await task.completed; }
  catch (error) {
    await fs.writeFile(path.join(directory, "process-result.json"), JSON.stringify(error.result || { reason: error.message }, null, 2));
    throw error;
  }
}

try {
  const state = await prepareLogin();
  summary.checks.loginExport = "passed";
  // 离线取消和负例先验证；两者均不调用真实模型。
  if (selected("init")) {
    const cancelled = await probe("cancel-probe", state);
    assert.equal(cancelled.terminal.status, "cancelled");
    summary.checks.cancel = cancelled.terminal;
  }
  if (selected("error")) {
    try {
      await probe("error-probe", state);
      assert.fail("注入错误不应成功");
    } catch (error) {
      assert.equal(error.result?.terminal?.status, "failed");
      assert.equal(error.result.terminal.modelCalls, 1);
      assert.equal(error.result.terminal.actions, 0);
      assert.equal(error.result.terminal.cleanupConfirmed, true);
      assert.equal(error.result.code, 1);
      summary.checks.failStop = "passed: one call, zero actions, browser closed";
    }
  }
  if (selected("explore") && realModel) {
    phase = "explore";
    const model = await resolveModel(realModel);
    const explored = await probe("explore", state, model);
    summary.checks.explore = explored.terminal;
    assert.deepEqual(clicks.filter(c => c.phase === "explore").map(c => c.id), ["Beta"]);
    const action = explored.events.find(e => e.type === "action" && e.action.click);
    assert.equal(action.target.role, "button");
    assert.equal(action.target.name, "Detail");
    assert.ok(action.ancestors.some(a => a.attributes["data-row"] === "Beta"));
    assert.ok(action.evidence);
    await fs.access(path.join(output, "explore", action.evidence));
    const done = explored.events.find(e => e.type === "action" && e.action.done);
    assert.equal(done?.observed?.identityConfirmed, true);
    assert.equal(done?.observed?.asyncResultVisible, true);
    summary.checks.stableTarget = "passed";
  } else if (selected("explore")) summary.checks.explore = "not-run: model not selected";
  if (selected("replay")) {
    phase = "replay";
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ storageState: state });
    const page = await context.newPage();
    await page.goto(url);
    assert.equal(await page.getByTestId("identity").textContent(), "smoke-reviewer");
    await page.locator('[data-row="Beta"]').getByRole("button", { name: "Detail", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "Beta · ready" }).waitFor();
    assert.deepEqual(clicks.filter(c => c.phase === "replay").map(c => c.id), ["Beta"]);
    summary.checks.independentReplay = "passed";
  }
  summary.status = "passed";
} catch (error) {
  summary.status = "failed";
  summary.exceptions.push({ reason: error.message, result: error.result });
  process.exitCode = 1;
} finally {
  await browser?.close();
  if (login && login.exitCode === null) login.kill();
  await new Promise(resolve => server.close(resolve));
  summary.finishedAt = new Date().toISOString();
  await fs.writeFile(path.join(output, "summary.json"), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify({ status: summary.status, scope: check, checks: Object.keys(summary.checks), output }));
}
