// 交互式系统验收：仅使用临时数据；需通过原生桌面操作，不自动点击或模拟输入。
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
require("../tests/helpers/pi-test-isolation.cjs");
const { createExtensionUiBridge } = require("../src/main/resources/extension-ui-bridge.js");
const { createDesktopPiOptions } = require("../src/main/resources/desktop-pi-options.js");
const { createSessionService } = require("../src/main/services/session-service.js");
const { createPromptSettingsStore } = require("../src/main/storage/prompt-settings-store.js");
const { createSessionStateStore } = require("../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../src/main/services/composer-draft-service.js");
const { createChatService } = require("../src/main/services/chat-service.js");
const { registerAgentIpc } = require("../src/main/ipc/agent-ipc.js");
const { registerWindowCloseGuard } = require("../src/main/lifecycle/window-close-guard.js");
const { registerAppQuitGuard } = require("../src/main/lifecycle/app-quit-guard.js");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-system-acceptance-")));
  const cwd = path.join(root, "workspace"), agentDir = path.join(root, "agent");
  await fs.mkdir(path.join(cwd, ".pi/extensions"), { recursive: true });
  await fs.mkdir(path.join(agentDir, "extensions"), { recursive: true });
  await fs.mkdir(path.join(root, "user-data"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  app.setPath("userData", path.join(root, "user-data"));
  await fs.writeFile(path.join(cwd, ".pi/extensions/project.js"), `export default function(pi) {
    pi.on("session_start", (_event, ctx) => ctx.ui.setStatus("project", "受信任项目扩展已加载"));
  }`);
  const shutdownFile = path.join(root, "shutdown.txt");
  await fs.writeFile(path.join(agentDir, "extensions/system.js"), `import fs from "node:fs/promises";
    export default function(pi) {
      pi.on("session_shutdown", async (_event, ctx) => { await fs.appendFile(${JSON.stringify(shutdownFile)}, ctx.sessionManager.getSessionId() + "\\n"); });
      pi.registerCommand("system-wait", { handler: async (_args, ctx) => {
        await ctx.ui.input("系统关闭验收：等待输入");
      }});
    }`);
  await app.whenReady();
  globalThis.fetch = async () => assert.fail("系统验收不得请求模型");
  const { createPiAgent } = await import("../src/main/pi-agent.mjs");
  const bridge = createExtensionUiBridge();
  bridge.register(ipcMain);
  const stateStore = createSessionStateStore(path.join(root, "state"));
  const promptStore = createPromptSettingsStore(path.join(root, "prompt.json"), async () => {
    const { TEST_AGENT_PROMPT } = await import("../src/main/prompts/test-agent-prompt.mjs");
    return TEST_AGENT_PROMPT;
  });
  const report = { status: "running", trust: [], windows: [], composition: { starts: 0, ends: 0, submitsDuringComposition: 0, entersDuringComposition: 0, closesDuringComposition: 0 } };
  let win, finalSessionId, restoring = false;
  const desktop = createDesktopPiOptions({ showMessageBox: options => dialog.showMessageBox(win, options) });
  const service = createSessionService(path.join(root, "sessions"), (dir, resume, file, workspace, recovery, resumeOptions) => createPiAgent(
    dir, resume, file, workspace, { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1" }, recovery, resumeOptions,
    undefined, { ...desktop, createUiContext: bridge.createContext, cancelUi: bridge.cancelSession, cancelPendingUi: bridge.cancelPending,
      askProjectTrust: async directory => {
        const answer = await desktop.askProjectTrust(directory);
        report.trust.push(answer);
        console.log("SYSTEM_TRUST", JSON.stringify(answer));
        return answer;
      },
    },
  ), () => cwd, async () => {}, stateStore);
  service.cancelExtensionUi = bridge.cancelAll;
  // 模型菜单只展示临时 SDK 模型；不读取应用真实配置或触发真实认证。
  service.listModels = async () => ({ provider: "openai", modelId: "gpt-4", models: [{ id: "gpt-4", name: "离线系统验收", provider: "openai" }] });
  const chat = createChatService(service, undefined, undefined, stateStore);
  const composer = createComposerDraftService(service, stateStore);
  const models = { readConfiguration: async () => ({ modelsPath: path.join(agentDir, "models.json") }), openConfiguration: async () => {} };
  registerAgentIpc(ipcMain, service, chat, {}, {}, {}, {}, { listProjects: async () => [] }, composer, models, promptStore);
  const quit = registerAppQuitGuard(app, BrowserWindow);
  ipcMain.on("pi-system:composition", (_event, type) => {
    if (type === "start") report.composition.starts++;
    if (type === "end") report.composition.ends++;
    if (type === "submit") report.composition.submitsDuringComposition++;
    if (type === "enter") report.composition.entersDuringComposition++;
    console.log("SYSTEM_COMPOSITION", type);
  });
  // 记录来自真实 DOM 的组词事件；不派发事件、不改变页面输入。
  const recorder = path.join(root, "recorder.cjs");
  await fs.writeFile(recorder, `require(${JSON.stringify(path.resolve(__dirname, "../src/preload/preload.js"))});
    const { ipcRenderer } = require("electron");
    window.addEventListener("DOMContentLoaded", () => {
      document.querySelector("#system-start")?.addEventListener("click", () => ipcRenderer.send("pi-system:start"));
      let composing = false;
      document.addEventListener("compositionstart", () => { composing = true; ipcRenderer.send("pi-system:composition", "start"); }, true);
      document.addEventListener("compositionend", () => { composing = false; ipcRenderer.send("pi-system:composition", "end"); }, true);
      document.addEventListener("keydown", event => { if (composing && event.key === "Enter") ipcRenderer.send("pi-system:composition", "enter"); }, true);
      document.addEventListener("submit", () => { if (composing) ipcRenderer.send("pi-system:composition", "submit"); }, true);
    });`);
  async function createWindow() {
    win = new BrowserWindow({ width: 1100, height: 820, show: true,
      webPreferences: { preload: recorder, contextIsolation: true, nodeIntegration: false, sandbox: false },
    });
    win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_request, done) => done({ cancel: true }));
    win.on("close", () => {
      if (report.composition.starts > report.composition.ends) report.composition.closesDuringComposition++;
    });
    registerWindowCloseGuard(win, ipcMain, quit.cancelQuit, async () => {
      finalSessionId = await service.currentSession();
      await service.closeSession();
    });
    win.once("closed", async () => {
      try {
        bridge.disconnect();
        const state = await stateStore.load(finalSessionId);
        assert.equal(state.pendingSend, null, "关闭后不应遗留待确认发送");
        const shutdowns = (await fs.readFile(shutdownFile, "utf8")).trim().split("\n");
        assert.ok(shutdowns.includes(finalSessionId), "关闭需等待扩展清理完成");
        report.windows.push({ draftSaved: state.draft.text, shutdownCompleted: true });
        console.log("SYSTEM_WINDOW_CLOSED", JSON.stringify(report.windows.at(-1)));
        if (!restoring) {
          assert.equal(state.draft.text, "中文关窗验收");
          restoring = true;
          // 沿用应用自己的可信空会话恢复入口，不伪造 Pi 历史文件。
          await service.restoreUnsentSession(finalSessionId);
          await createWindow();
          console.log("SYSTEM_REOPENED：请核对输入，然后发送 /system-wait，关闭等待中的窗口。");
        } else {
          assert.equal(state.draft.text, "");
          assert.equal(report.composition.submitsDuringComposition, 0);
          // 分支覆盖按实际选择记录，不能把没有执行的拒绝分支算作通过。
          report.trustCoverage = { allowed: report.trust.some(answer => answer.trusted), rejected: report.trust.some(answer => !answer.trusted) };
          assert.ok(report.trustCoverage.allowed, "本场景需允许临时项目扩展加载");
          report.status = "passed";
          await finish();
        }
      } catch (error) { await finish(error); }
    });
    if (!restoring) {
      // 先显示可见入口，避免初始化弹窗出现时桌面控制尚未连接。
      const startFile = path.join(root, "start.html");
      await fs.writeFile(startFile, '<meta charset="utf-8"><h1>Pi 原生系统验收</h1><p>本场景请选择信任并记住；如先拒绝，可新建对话后重新选择。</p><button id="system-start">开始验收</button>');
      await win.loadFile(startFile);
      await new Promise(resolve => ipcMain.once("pi-system:start", resolve));
    }
    await win.loadFile(path.resolve(__dirname, "../src/renderer/index.html"));
    console.log("SYSTEM_WINDOW_READY");
  }
  async function finish(error) {
    if (error) { report.status = "failed"; report.error = error.message; }
    console.log("SYSTEM_RESULT", JSON.stringify(report));
    if (process.env.PI_ACCEPTANCE_REPORT) await fs.writeFile(process.env.PI_ACCEPTANCE_REPORT, JSON.stringify(report, null, 2) + "\n");
    await fs.rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    app.exit(error ? 1 : 0);
  }
  console.log("SYSTEM_STEPS：开始验收 → 信任并记住 → 输入中文关窗验收并关闭 → 恢复后发送 /system-wait 并关闭。");
  await createWindow();
}
main().catch(error => { console.error(error); app.exit(1); });
