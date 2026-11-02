const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { app, BrowserWindow, ipcMain } = require("electron");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");
const { createComposerDraftService } = require("../../src/main/services/composer-draft-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
const temporary = mkdtempSync(path.join(os.tmpdir(), "session-archive-ui-"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.commandLine.appendSwitch("disable-http-cache");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const root = path.resolve(__dirname, "../..");

async function main() {
  const canonical = await fs.realpath(temporary);
  const workspace = path.join(canonical, "project"), other = path.join(canonical, "other");
  await fs.mkdir(workspace); await fs.mkdir(other);
  const sessionDir = path.join(temporary, "sessions"); await fs.mkdir(sessionDir);
  const store = createSessionStateStore(path.join(temporary, "state"));
  const histories = [];
  for (const [id, cwd, time, title] of [["a", workspace, 3000, "当前对话"], ["b", workspace, 2000, "归档样例 <img src=x>"], ["c", other, 1000, "其他项目"]]) {
    const timestamp = new Date(time).toISOString();
    const content = [
      { type: "session", version: 3, id, cwd, timestamp },
      { type: "custom", id: "binding", parentId: null, timestamp, customType: "desktop-workspace-binding", data: { version: 1, workspaceRoot: cwd } },
      { type: "message", id: "u1", parentId: "binding", timestamp, message: { role: "user", content: title, timestamp: time } },
    ].map(entry => JSON.stringify(entry)).join("\n") + "\n";
    const filename = path.join(sessionDir, `${id}.jsonl`); await fs.writeFile(filename, content); histories.push([filename, content]);
  }
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const flags = {}, calls = [];
  let savedWorkspace = workspace;
  const factory = async (dir, resume, sessionPath, cwd, recovery, options) => {
    if (flags.createFail) throw Error("模拟创建失败");
    if (flags.createGate) await flags.createGate.promise;
    const result = await createWorkspaceSession({ sessionDir: dir, resume, sessionPath, workspaceDir: cwd, recovery, archivedSessionIds: options?.archivedSessionIds });
    return { sessionId: result.sessionManager.getSessionId(), sessionManager: result.sessionManager,
      desktopSessionOrigin: result.source, model: { provider: "mock", id: "model" },
      get messages() { return result.sessionManager.buildSessionContext().messages; }, dispose() {} };
  };
  let service = createSessionService(sessionDir, factory, () => savedWorkspace, async cwd => { savedWorkspace = cwd; }, store);
  let composer = createComposerDraftService(service, store);
  const proposals = new Map([["a", [{ id: "file-a" }]]]);
  const session = {
    loadHistory: () => service.loadHistory(), currentSession: () => { if (flags.currentFail) throw Error("模拟编号核对失败"); return service.currentSession(); },
    getSessionInfo: async () => ({ sessionId: await service.currentSession(), workspaceDir: (await service.getSession()).sessionManager.getCwd(), provider: "mock", modelId: "model", contextUsage: null }),
    listModelProfiles: async () => ({ currentProfileId: "mock", profiles: [{ id: "mock", name: "测试模型", provider: "mock", modelId: "model" }] }),
    listUnsentSessions: () => service.listUnsentSessions(),
    listSessions: () => { if (flags.listFail) throw Error("模拟列表失败"); return service.listSessions(); },
    openSession: id => service.openSession(id),
    setSessionPinned: (id, pinned) => service.setSessionPinned(id, pinned),
    previewSession: id => { calls.push(["preview", id]); return service.previewSession(id); },
    setSessionArchived: async (id, archived) => {
      calls.push(["archive", id, archived]);
      if (flags.archiveGate) await flags.archiveGate.promise;
      if (flags.archiveFail) throw Error("模拟归档写入失败");
      const result = await service.setSessionArchived(id, archived);
      if (flags.resultLost) throw Error("模拟结果丢失");
      return result;
    },
  };
  const flow = { list: () => [], subscribe: () => () => {} };
  registerAgentIpc(ipcMain, session, {
    isBusy: () => Boolean(flags.generating),
    listProposals: async () => proposals.get(await service.currentSession()) ?? [],
  }, {}, {}, {}, {}, {
    listProjects: async () => [{ id: "p", name: "演示项目", workspaceDir: workspace }],
  }, {
    loadCurrentDraft: () => composer.loadCurrentDraft(), inspectSend: id => composer.inspectSend(id),
    saveDraft: async (...args) => {
      if (flags.saveFail) throw Error("模拟输入保存失败");
      return composer.saveDraft(...args);
    },
  }, { read: async () => ({ profiles: [], providers: [], defaultProfileId: null, encryptionAvailable: true }),
    oauth: flow, enrichment: flow });
  await app.whenReady();
  const win = new BrowserWindow({ width: 1120, height: 820, show: false,
    webPreferences: { preload: path.join(root, "src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_d, done) => done({ cancel: true }));
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const js = code => win.webContents.executeJavaScript(code);
  const until = condition => js(`(async()=>{for(let i=0;i<500;i++){if(${condition})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败:'+${JSON.stringify(condition)});})()`);
  const idle = () => until(`!document.getElementById('new-chat-button').disabled&&!document.getElementById('model-select').disabled`);
  const click = selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const row = id => `.session-row[data-session-id="${id}"]`;
  const archive = async id => { await click(`${row(id)} .session-actions-toggle`); await click(`${row(id)} .session-archive-action`); };
  const restore = async id => { await click(`${row(id)} .session-actions-toggle`); await click(`${row(id)} .session-pin-action`); };
  const view = async archived => {
    if (archived) {
      if (!await js(`document.querySelector('#model-settings-dialog').open`)) {
        await click('#model-settings-button');
        await until(`document.querySelector('#model-settings-dialog').getAttribute('aria-busy')==='false'`);
      }
      await click('#settings-archive-tab');
    } else await click('#model-settings-dialog [data-close]');
  };
  const edit = text => js(`document.getElementById('message-input').value=${JSON.stringify(text)};document.getElementById('message-input').dispatchEvent(new Event('input'))`);
  const passed = [];
  const check = async (name, fn) => { await fn(); passed.push(name); console.log("通过", name); };
  try {
    await win.loadFile(path.join(root, "src/renderer/index.html")); await idle();
    await edit("归档前中文输入\n最后一行");
    await check("归档其他会话只改状态，输入/文件草稿/置顶/历史均保留", async () => {
      await service.setSessionPinned("b", true);
      await store.saveDraft("b", workspace, "B输入", 0);
      const before = await store.load("b");
      await archive("b"); await idle();
      assert.equal(await service.currentSession(), "a");
      assert.equal(await js(`document.querySelectorAll('.session-open:not([data-empty-session])').length`), 2);
      assert.equal(await js(`document.getElementById('message-input').value`), "归档前中文输入\n最后一行");
      assert.equal(await js(`document.querySelectorAll('#proposal-list article').length`), 1);
      const after = await store.load("b"); assert.deepEqual(after.draft, before.draft); assert.equal(after.pinnedAt, before.pinnedAt);
      assert.equal(await js(`document.querySelector('.archive-notice').hidden`), false);
      assert.equal(await js(`document.querySelector('#history-preview')`), null);
    });
    await check("撤销不自动打开原会话，不打断新输入", async () => {
      await edit("撤销前后来输入"); await click(".archive-notice button"); await idle();
      assert.equal(await service.currentSession(), "a"); assert.equal((await store.load("b")).archivedAt, null);
      assert.equal(await js(`document.getElementById('message-input').value`), "撤销前后来输入");
    });
    await archive("b"); await idle();
    await check("已归档视图按目录分组，可搜索，点击仅只读预览", async () => {
      await view(true);
      assert.equal(await js(`document.querySelectorAll('#session-list .session-open:not([data-empty-session])').length`), 2);
      assert.equal(await js(`document.querySelector('#session-list .session-view-switch')`), null);
      assert.equal(await js(`document.querySelector('#settings-archive-panel').hidden`), false);
      assert.equal(await js(`document.querySelectorAll('.session-preview').length`), 1);
      await click(".session-preview");
      await until(`document.querySelector('#archive-history-preview [role=status]').textContent.includes('只读预览：')`);
      assert.equal(await service.currentSession(), "a"); assert.equal(calls.at(-1)[0], "preview");
      assert.equal(await js(`document.querySelectorAll('#session-list img').length`), 0);
      await js(`document.getElementById('archive-session-search').value='无匹配';document.getElementById('archive-session-search').dispatchEvent(new Event('input'))`);
      assert.equal(await js(`document.querySelectorAll('.session-preview').length`), 0);
      await js(`document.getElementById('archive-session-search').value='归档样例';document.getElementById('archive-session-search').dispatchEvent(new Event('input'))`);
      assert.equal(await js(`document.querySelectorAll('.session-preview').length`), 1);
      assert.equal(await js(`document.querySelector('#session-search').value`), "");
    });
    await check("设置中恢复失败保留归档项，刷新后可继续恢复", async () => {
      flags.archiveFail = true; await restore("b"); await idle(); flags.archiveFail = false;
      assert.match(await js(`document.querySelector('#archive-session-list .session-list-status').textContent`), /未完成/);
      assert.equal(await js(`document.querySelectorAll('#archive-session-list .session-preview').length`), 1);
      await click('#archive-session-list .session-list-retry'); await idle();
      assert.equal(await service.currentSession(), "a");
      assert.equal(await js(`document.querySelector('#model-settings-dialog').open`), true);
    });
    await check("提示消失或页面重载后仍可从归档列表恢复", async () => {
      await win.reload(); await idle(); await view(true);
      assert.equal(await js(`document.querySelector('.archive-notice').hidden`), true);
      flags.archiveGate = Promise.withResolvers();
      await restore("b");
      await until(`document.querySelector('#settings-archive-tab').disabled`);
      assert.equal(await js(`document.querySelector('#archive-session-search').disabled && [...document.querySelectorAll('#archive-session-list button')].every(b=>b.disabled)`), true);
      flags.archiveGate.resolve(); flags.archiveGate = null; await idle();
      assert.equal(await service.currentSession(), "a");
      assert.equal((await store.load("b")).draft.text, "B输入");
      assert.equal(await js(`document.querySelector('#archive-session-list .session-list-empty').textContent`), "暂无已归档对话。");
      await view(false);
    });
    await check("当前归档前输入保存失败，不进入归档并保留页面", async () => {
      flags.saveFail = true; await edit("保存失败仍保留");
      const count = calls.filter(c => c[0] === "archive").length;
      await archive("a"); await idle(); flags.saveFail = false;
      assert.equal(calls.filter(c => c[0] === "archive").length, count);
      assert.equal(await service.currentSession(), "a");
      assert.equal(await js(`document.getElementById('message-input').value`), "保存失败仍保留");
    });
    await check("候选创建失败不归档，输入和文件草稿保留", async () => {
      flags.createFail = true; await archive("a"); await idle(); flags.createFail = false;
      assert.equal(await service.currentSession(), "a"); assert.equal((await store.load("a")).archivedAt, null);
      assert.equal(await js(`document.querySelectorAll('#proposal-list article').length`), 1);
    });
    await check("归档保存失败可重试，不切换当前会话", async () => {
      flags.archiveFail = true; await archive("a"); await idle(); flags.archiveFail = false;
      assert.equal(await service.currentSession(), "a"); assert.equal((await store.load("a")).archivedAt, null);
      assert.equal(await js(`document.getElementById('message-input').readOnly`), false);
    });
    let replacement;
    await check("当前归档等待期间冻结输入与切换，成功进入同目录空对话", async () => {
      await edit("当前会话归档原文");
      flags.createGate = Promise.withResolvers();
      await archive("a");
      await until(`document.getElementById('new-chat-button').disabled`);
      assert.equal(await js(`document.getElementById('message-input').readOnly`), true);
      assert.equal(await js(`[...document.querySelectorAll('#session-list button')].every(b=>b.disabled)`), true);
      flags.createGate.resolve(); flags.createGate = null; await idle();
      replacement = await service.currentSession(); assert.notEqual(replacement, "a");
      assert.equal((await service.getSession()).sessionManager.getCwd(), workspace);
      assert.equal((await store.load("a")).draft.text, "当前会话归档原文");
      assert.equal(await js(`document.getElementById('message-input').value`), "");
      assert.equal(await js(`document.querySelectorAll('#proposal-list article').length`), 0);
      assert.equal(proposals.get("a").length, 1);
    });
    await check("撤销当前归档保留替代会话的新输入，手动打开才恢复原输入和草稿", async () => {
      await edit("新会话输入不被撤销打断"); await click(".archive-notice button"); await idle();
      assert.equal(await service.currentSession(), replacement);
      assert.equal(await js(`document.getElementById('message-input').value`), "新会话输入不被撤销打断");
      await click('.session-open[data-session-id="a"]'); await idle();
      assert.equal(await js(`document.getElementById('message-input').value`), "当前会话归档原文");
      assert.equal(await js(`document.querySelectorAll('#proposal-list article').length`), 1);
    });
    await check("归档已保存但列表刷新失败可核对，不重复归档", async () => {
      flags.listFail = true; await archive("b"); await idle();
      assert.match(await js(`document.querySelector('.session-list-status').textContent`), /已保存/);
      const count = calls.length; flags.listFail = false;
      await click('.session-list-retry'); await idle(); assert.equal(calls.length, count);
      assert.equal(await js(`document.querySelectorAll('.session-open:not([data-empty-session])').length`), 2);
    });
    await check("当前归档返回丢失时核对实际编号并绑定新会话，不回填旧输入", async () => {
      flags.resultLost = true; await archive("a"); await idle(); flags.resultLost = false;
      replacement = await service.currentSession(); assert.notEqual(replacement, "a");
      assert.equal(await js(`document.getElementById('message-input').value`), "");
      assert.equal(await js(`document.getElementById('message-input').readOnly`), false);
      assert.equal((await store.load("a")).draft.text, "当前会话归档原文");
      await click('.session-list-retry'); await idle();
    });
    await view(true); await restore("a"); await idle(); await view(false);
    await click('.session-open[data-session-id="a"]'); await idle();
    await check("结果及编号核对都失败时保留冻结，仅刷新核对后恢复操作", async () => {
      flags.resultLost = true; flags.currentFail = true;
      await archive("a");
      await until(`!document.querySelector('.session-list-retry').hidden&&!document.querySelector('.session-list-retry').disabled`);
      assert.equal(await js(`document.getElementById('message-input').readOnly`), true);
      assert.equal(await js(`document.getElementById('send-button').disabled&&document.getElementById('new-chat-button').disabled`), true);
      flags.resultLost = false; flags.currentFail = false;
      const count = calls.length; await click('.session-list-retry'); await idle(); assert.equal(calls.length, count);
      assert.equal(await js(`document.getElementById('message-input').value`), "");
      assert.equal(await js(`document.getElementById('message-input').readOnly`), false);
    });
    await check("后台恢复服务重建后不会自动打开归档项，历史字节不变", async () => {
      const restarted = createSessionService(sessionDir, factory, () => workspace, async () => {}, store);
      const current = await restarted.getSession(true); assert.ok(!["a", "b"].includes(current.sessionId));
      for (const [filename, content] of histories) assert.equal(await fs.readFile(filename, "utf8"), content);
    });
    for (const width of [1120, 760, 375]) {
      await check(`归档视图${width}宽度无溢出，恢复保持侧栏`, async () => {
        win.setSize(width, 820); await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        if (await js(`document.getElementById('app-sidebar').hidden`)) await click('#sidebar-toggle');
        await view(true);
        await js(`document.documentElement.dataset.theme=${JSON.stringify(width === 760 ? 'sakura' : 'dark')}`);
        await click(`${row("a")} .session-actions-toggle`);
        assert.equal(await js(`document.documentElement.scrollWidth<=innerWidth&&['settings-archive-panel','archive-session-list'].every(id=>{const e=document.getElementById(id);return e.scrollWidth<=e.clientWidth+1})`), true);
        assert.equal(await js(`document.querySelector('.settings-sidebar').getBoundingClientRect().right<=document.querySelector('#settings-archive-panel').getBoundingClientRect().left+1`), true);
        await js(`new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
        await fs.writeFile(path.join(temporary, `archive-${width}.png`), (await win.webContents.capturePage()).toPNG());
        await click(`${row("a")} .session-pin-action`); await idle();
        assert.equal(await js(`document.getElementById('app-sidebar').hidden`), false);
        assert.equal(await js(`document.getElementById('model-settings-dialog').open && document.activeElement.closest('#archive-session-list')!==null`), true);
        await view(false); await archive("a"); await idle();
      });
    }
    assert.deepEqual(errors, []);
    await fs.writeFile(path.join(temporary, "report.json"), JSON.stringify({ count: passed.length, passed }, null, 2));
    console.log(`归档页面 ${passed.length} 项通过，报告：${temporary}`);
  } finally { win.destroy(); }
}
const timeout = setTimeout(() => { console.error("归档页面检查超时"); app.exit(1); }, 60000);
main().then(() => { clearTimeout(timeout); app.quit(); }).catch(error => { clearTimeout(timeout); console.error(error); app.exit(1); });
