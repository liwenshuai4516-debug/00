const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, rm } = require("node:fs/promises");
const { app, BrowserWindow, ipcMain } = require("electron");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const root = path.resolve(__dirname, "../..");
  const temporary = await mkdtemp(path.join(os.tmpdir(), "new-chat-ready-"));
  await mkdir(path.join(temporary, "user-data"), { recursive: true });
  app.setPath("userData", path.join(temporary, "user-data"));
  app.setPath("sessionData", path.join(temporary, "user-data"));
  await app.whenReady();

  let current = "initial";
  const gates = { models: null, unsent: null };
  ipcMain.handle("sidebar-check", async (_event, name, args) => {
    if (name === "currentSession") return current;
    if (name === "newChat") {
      current = "fresh";
      return current;
    }
    if (name === "listSessions") return [];
    if (name === "loadHistory") return [];
    if (name === "listProposals") return [];
    if (name === "listProjects") return [];
    if (name === "listProjectEnvironments") return [];
    if (name === "getSessionInfo") {
      return {
        sessionId: current,
        workspaceDir: "/demo",
        provider: "demo",
        modelId: "demo",
        contextUsage: null,
      };
    }
    if (name === "listModels") {
      if (gates.models) await gates.models.promise;
      return {
        provider: "demo",
        modelId: "demo",
        models: [{ id: "demo", name: "演示模型", provider: "demo" }],
      };
    }
    if (name === "listUnsentSessions") {
      if (gates.unsent) await gates.unsent.promise;
      return [];
    }
    if (name === "loadComposerDraft" || name === "inspectComposerSend") {
      return { sessionId: current, text: "", revision: 0, pendingSend: null };
    }
    if (name === "saveComposerDraft") {
      return { sessionId: current, text: args[1], revision: args[2] + 1 };
    }
    if (name === "readModelConfiguration") return { modelsPath: "/demo/models.json" };
    throw Error("未登记的模拟接口：" + name);
  });

  const win = new BrowserWindow({
    width: 1120,
    height: 820,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "sidebar-layout.preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.webContents.session.webRequest.onBeforeRequest(
    { urls: ["http://*/*", "https://*/*"] },
    (_details, done) => done({ cancel: true }),
  );
  await win.loadFile(path.join(root, "src/renderer/index.html"));
  const run = source => win.webContents.executeJavaScript(source);
  const wait = async (expression, timeout = 5000) => {
    const started = Date.now();
    while (Date.now() - started < timeout) {
      if (await run(expression)) return Date.now() - started;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    throw new Error("等待失败：" + expression);
  };

  try {
    await wait(`!document.getElementById('new-chat-button').disabled&&!document.getElementById('model-select').disabled`);

    // 新对话只依赖会话创建和输入绑定；模型目录与未发送列表的慢读取不能锁住输入。
    gates.models = Promise.withResolvers();
    gates.unsent = Promise.withResolvers();
    await run(`document.getElementById('messages').append(document.createElement('p'))`);
    const started = Date.now();
    await run(`document.getElementById('new-chat-button').click()`);
    const ready = await wait(`!document.getElementById('send-button').disabled&&document.getElementById('request-status').textContent==='就绪'`);
    const elapsed = Date.now() - started;
    assert.ok(elapsed < 1200, `新对话应在辅助刷新完成前可用，实际 ${elapsed} ms`);
    assert.equal(await run(`document.getElementById('messages').childElementCount`), 0);

    gates.models.resolve();
    gates.unsent.resolve();
    await wait(`!document.getElementById('model-select').disabled`);
    console.log(`新对话就绪 ${ready} ms，后台刷新未阻塞。`);
  } finally {
    gates.models?.resolve();
    gates.unsent?.resolve();
    win.destroy();
    await rm(temporary, { recursive: true, force: true, maxRetries: 5 });
  }
}

main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
