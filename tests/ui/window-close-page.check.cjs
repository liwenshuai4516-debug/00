const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temporary = mkdtempSync(path.join(os.tmpdir(), "window-close-ui-"));
const { app, BrowserWindow, ipcMain } = require("electron");
const root = path.resolve(__dirname, "../..");
const { registerAgentIpc } = require(path.join(root, "src/main/ipc/agent-ipc.js"));
mkdirSync(path.join(temporary, "user-data"));
app.setPath("userData", path.join(temporary, "user-data"));
app.commandLine.appendSwitch("disable-http-cache");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});
const flags = {}, calls = [], drafts = new Map();
const entry = id => {
  if (!drafts.has(id)) drafts.set(id, { sessionId: id, text: "", revision: 0 });
  return drafts.get(id);
};
Object.assign(entry("a"), { text: "原输入", revision: 1 });
Object.assign(entry("b"), { text: " 完整原文\r\n第二行 \n", revision: 2 });
Object.assign(entry("c"), { text: "", revision: 3 });
let runningCompaction;
let current = "a", workspace = "/qa/one", serial = 0, generating = false, runningGate;
const history = id => id === "b" ? [] : [{ role: "user", text: `保留消息 ${id}` }];
const failure = name => { if (flags[name]) { flags[name] = false; throw Error(`模拟${name}失败`); } };
const pause = async name => { if (flags[name]) { const gate = flags[name]; flags[name] = null; await gate.promise; } };
const session = {
  loadHistory: async () => { await pause("initGate"); return history(current); }, currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: workspace, modelId: current === "b" ? "Pro" : "Flash", provider: "mock", contextUsage: null }),
  listModelProfiles: async () => ({ currentProfileId: current === "b" ? "pro" : "flash", profiles: [{ id:"flash", name:"Flash", provider:"mock", modelId:"Flash" },{ id:"pro",name:"Pro",provider:"mock",modelId:"Pro" }] }),
  listSessions: async () => { failure("historyList"); return ["a", "b"].map(id => ({ id, title: `对话 ${id}`, workspaceDir: workspace, updatedAt: 10 })); },
  listUnsentSessions: async () => {
    calls.push(["list",current,workspace]); await pause("listGate"); failure("list");
    if (workspace !== "/qa/one") return [];
    return ["a","b","c"].filter(id => id === "c" || entry(id).text.length).map(id => ({ id, title:id === "c" ? "待确认输入" : `摘要 ${id}`, workspaceDir:workspace, blockedReason:id === "c" ? "仍有待确认发送，暂不能重建。" : "" }));
  },
  restoreUnsentSession: async id => {
    calls.push(["restore",id,entry(current).text]); await pause("restoreGate"); failure("restore");
    assert.notEqual(id,"c"); current=id; return { sessionId:id,workspaceDir:workspace,history:history(id) };
  },
  openSession: async id => { await pause("openGate"); current=id; return history(id); },
  newChat: async () => { current=`new-${++serial}`; return current; },
  renameSession: async () => {},
  compactSession: async () => { calls.push(["compact"]); runningCompaction = flags.compactGate; await pause("compactGate"); return { history:history(current), stopped:true }; },
  cancelCompaction: async () => { calls.push(["cancel"]); failure("cancel"); runningCompaction?.resolve(); },
  previewSession: async id => ({ history:history(id) }),
};
const composer = {
  loadCurrentDraft: async () => { calls.push(["load",current]); failure("load"); return { ...entry(current) }; },
  inspectSend: async id => { calls.push(["inspect",id]); return { ...entry(id), pendingSend:null }; },
  saveDraft: async (id,text,revision) => {
    calls.push(["save",id,text]); await pause("saveGate"); failure("save");
    if (flags.failSaveIds?.has(id)) throw Error("模拟磁盘失败");
    assert.equal(revision,entry(id).revision); Object.assign(entry(id), { text,revision:revision+1 }); return { ...entry(id) };
  },
};
const chat = {
  isBusy: () => generating,
  listProposals: async () => { calls.push(["proposals",current]); failure("proposals"); return [{ id:`proposal-${current}` }]; },
  async send(text,onText,onTool,onStatus,draft,onAck) {
    calls.push(["send", current, text]); generating=true; entry(current).text=""; entry(current).revision++;
    const ack={ sessionId:current,text:"",revision:entry(current).revision,sendId:"send-1" }; onAck(ack); onText("模拟回复");
    runningGate=flags.sendGate; await pause("sendGate"); generating=false; return { outcome:"completed",stopped:true,draft:ack };
  },
  stop: async () => { calls.push(["stop"]); failure("stop"); runningGate?.resolve(); },
};
registerAgentIpc(ipcMain,session,chat,{}, {}, { exportConversation:async () => ({ canceled:true }) },
  { selectWorkspace:async () => { workspace="/qa/two"; current="other"; return { sessionId:current,workspaceDir:workspace }; } },
  { listProjects:async () => [{ id:"p",name:"测试项目",workspaceDir:"/qa/one" }],openProject:async () => { workspace="/qa/one"; current="a"; return { sessionId:current,history:history(current) }; },addProject:async () => ({ canceled:true }) },composer,{read:async()=>({profiles:[],providers:[],defaultProfileId:"",encryptionAvailable:false,environment:null})});


const { registerWindowCloseGuard } = require(path.join(root, "src/main/lifecycle/window-close-guard.js"));
const { registerAppQuitGuard } = require(path.join(root, "src/main/lifecycle/app-quit-guard.js"));
const quitGuard = registerAppQuitGuard(app, BrowserWindow);
const requests = [], results = [], errors = [], passed = [];
ipcMain.on("agent:close-result", (event, result) => results.push({ sender:event.sender.id, ...result }));
async function fresh({ beforeLoad = false } = {}) {
  current="a"; workspace="/qa/one"; generating=false; runningGate=null; runningCompaction=null;
  for (const key of Object.keys(flags)) if(key!=="initGate") delete flags[key];
  const win=new BrowserWindow({width:1120,height:820,show:false,webPreferences:{preload:path.join(root,"src/preload/preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false}});
  win.webContents.session.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},(_d,done)=>done({cancel:true}));
  win.webContents.on("console-message", details => { if(details.level==="error") errors.push(details.message); });
  registerWindowCloseGuard(win,ipcMain,quitGuard.cancelQuit);
  const originalSend=win.webContents.send.bind(win.webContents);
  win.webContents.send=(channel,...args)=>{if(channel==="agent:prepare-close")requests.push(args[0]);return originalSend(channel,...args);};
  const closed=()=>new Promise(resolve=>win.once("closed",resolve));
  const js=code=>win.webContents.executeJavaScript(code);
  const until=async code=>{
    const end=Date.now()+6000;
    while(!await js(code)){if(Date.now()>end)throw Error(`等待超时：${code}`);await new Promise(r=>setTimeout(r,15));}
  };
  const idle=()=>until('!document.getElementById("new-chat-button").disabled && !document.querySelector(".unsent-list-refresh").disabled');
  const click=selector=>js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const edit=text=>js(`document.getElementById("message-input").value=${JSON.stringify(text)};document.getElementById("message-input").dispatchEvent(new Event("input"));`);
  const loaded=win.loadFile(path.join(root,"src/renderer/index.html"));
  if(beforeLoad)win.close();
  await loaded;
  return {win,js,until,idle,click,edit,closed};
}
async function check(name,fn){await fn();passed.push(name);console.log("通过",name);}
const tick=()=>new Promise(resolve=>setTimeout(resolve,30));
async function main(){
  await app.whenReady();
  await check("未满自动保存间隔的最后编辑先落盘再关闭",async()=>{
    const s=await fresh();await s.idle();await s.edit("关闭前最后输入 中文\n第二行");
    const done=s.closed();s.win.close();await done;
    assert.equal(entry("a").text,"关闭前最后输入 中文\n第二行");assert.equal(results.at(-1).saved,true);
  });
  await check("慢保存期间保持模态冻结，重复关闭合并，成功后再关窗",async()=>{
    const s=await fresh();await s.idle();await s.edit("等待保存");flags.saveGate=Promise.withResolvers();const gate=flags.saveGate;
    const count=requests.length;const done=s.closed();s.win.close();s.win.close();
    await s.until('document.getElementById("window-close-dialog").open');
    assert.equal(s.win.isDestroyed(),false);assert.equal(requests.length,count+1);
    assert.equal(await s.js('document.getElementById("new-chat-button").disabled && document.getElementById("send-button").disabled'),true);
    await s.js('document.getElementById("window-close-dialog").dispatchEvent(new Event("cancel",{cancelable:true}))');
    assert.equal(await s.js('document.getElementById("window-close-dialog").open'),true);
    for(const width of [1120,760,375]){
      s.win.setContentSize(width,820);await tick();
      assert.equal(await s.js('document.documentElement.scrollWidth <= innerWidth+1'),true);
      assert.equal(await s.js('document.getElementById("window-close-dialog").contains(document.activeElement)'),true);
      await fs.writeFile(path.join(temporary,`close-${width}.png`),(await s.win.webContents.capturePage()).toPNG());
    }
    gate.resolve();await done;assert.equal(entry("a").text,"等待保存");
  });
  await check("保存失败留窗、保留输入和文件草稿，恢复焦点后可再次关闭",async()=>{
    const s=await fresh();await s.idle();const count=await s.js('document.querySelectorAll("#proposal-list article").length');
    await s.js('document.getElementById("message-input").focus()');await s.edit("失败后保留原文");flags.failSaveIds=new Set(["a"]);
    s.win.close();await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(s.win.isDestroyed(),false);assert.equal(await s.js('document.getElementById("window-close-dialog").open'),false);
    assert.equal(await s.js('document.getElementById("message-input").value'),"失败后保留原文");
    assert.equal(await s.js('document.querySelectorAll("#proposal-list article").length'),count);
    assert.equal(await s.js('document.activeElement.id'),"message-input");
    flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;assert.equal(entry("a").text,"失败后保留原文");
  });
  await check("关闭也补存本页面旧会话失败输入，失败不会漏过",async()=>{
    const s=await fresh();await s.idle();flags.failSaveIds=new Set(["a"]);await s.edit("旧会话未存");
    await s.until('document.getElementById("composer-draft-status").textContent.includes("未保存")');
    await s.click('#session-list .session-open[data-session-id="b"]');await s.idle();assert.equal(current,"b");await s.edit("新会话输入");
    s.win.close();await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(await s.js('document.getElementById("message-input").value'),"新会话输入");
    flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;
    assert.equal(entry("a").text,"旧会话未存");assert.equal(entry("b").text,"新会话输入");
  });
  await check("生成中关闭自动停止，保留生成中新输入，已消费原文不恢复",async()=>{
    const s=await fresh();await s.idle();await s.edit("已发送原文");flags.sendGate=Promise.withResolvers();
    await s.click('#send-button');await s.until('!document.getElementById("stop-button").disabled');await s.edit("生成中的新输入");
    const done=s.closed();s.win.close();await done;
    assert.equal(entry("a").text,"生成中的新输入");assert.equal(results.at(-1).saved,true);
  });
  await check("发送前保存期间关闭，等待后续生成启动并停止后才放行",async()=>{
    const s=await fresh();await s.idle();await s.edit("准备阶段原文");flags.saveGate=Promise.withResolvers();const save=flags.saveGate;
    flags.sendGate=Promise.withResolvers();const count=calls.filter(item=>item[0]==="send").length;
    await s.click('#send-button');await s.until('document.getElementById("new-chat-button").disabled');
    const done=s.closed();s.win.close();await s.until('document.getElementById("window-close-dialog").open');
    assert.equal(s.win.isDestroyed(),false);save.resolve();await done;
    assert.equal(calls.filter(item=>item[0]==="send").length,count+1);assert.equal(entry("a").text,"");
  });
  await check("整理中关闭先取消并等待原整理收尾，保留输入",async()=>{
    const s=await fresh();await s.idle();await s.edit("整理时保留");flags.compactGate=Promise.withResolvers();
    await s.click('#compact-session-button');await s.until('!document.getElementById("cancel-compaction-button").hidden');
    const done=s.closed();s.win.close();await done;assert.equal(entry("a").text,"整理时保留");assert(calls.some(item=>item[0]==="cancel"));
  });
  await check("停止失败留窗恢复生成状态，再次关闭可停止并保存",async()=>{
    const s=await fresh();await s.idle();await s.edit("停止失败原文");flags.sendGate=Promise.withResolvers();
    await s.click('#send-button');await s.until('!document.getElementById("stop-button").disabled');await s.edit("停止失败后新输入");flags.stop=true;
    s.win.close();await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(s.win.isDestroyed(),false);assert.equal(await s.js('document.getElementById("stop-button").disabled'),false);
    const done=s.closed();s.win.close();await done;assert.equal(entry("a").text,"停止失败后新输入");
  });
  await check("会话切换进行中关闭等待新编号绑定，再保存各自原文",async()=>{
    const s=await fresh();await s.idle();await s.edit("切换前A输入");flags.openGate=Promise.withResolvers();const gate=flags.openGate;
    await s.click('#session-list .session-open[data-session-id="b"]');await s.until('document.getElementById("new-chat-button").disabled');
    const done=s.closed();s.win.close();await s.until('document.getElementById("window-close-dialog").open');
    assert.equal(s.win.isDestroyed(),false);gate.resolve();await done;
    assert.equal(entry("a").text,"切换前A输入");assert.equal(current,"b");
  });
  await check("启动初始化期间关闭仍等待读取完成再确认",async()=>{
    flags.initGate=Promise.withResolvers();const gate=flags.initGate;const s=await fresh({beforeLoad:true});
    await s.until('document.getElementById("window-close-dialog").open');assert.equal(s.win.isDestroyed(),false);
    const done=s.closed();gate.resolve();await done;assert.equal(results.at(-1).saved,true);
  });
  await check("配置对话框已打开时关闭冻结全部交互，失败后仍能继续配置",async()=>{
    const s=await fresh();await s.idle();
    // 保留已有配置窗口，检查关闭模态冻结与失败恢复。
    await s.click('#model-settings-button');await s.until('document.getElementById("model-settings-dialog").open');
    await s.edit("配置窗口下的输入");flags.failSaveIds=new Set(["a"]);s.win.close();
    await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(await s.js('document.getElementById("model-settings-dialog").open'),true);
    flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;
  });
  await check("输入法组词未结束时不确认，结束后的最新文字落盘",async()=>{
    const s=await fresh();await s.idle();await s.js('document.getElementById("message-input").dispatchEvent(new CompositionEvent("compositionstart"))');
    s.win.close();await s.until('document.getElementById("window-close-dialog").open');await tick();assert.equal(s.win.isDestroyed(),false);
    const done=s.closed();await s.edit("最后中文组词");await s.js('document.getElementById("message-input").dispatchEvent(new CompositionEvent("compositionend"))');await done;
    assert.equal(entry("a").text,"最后中文组词");
  });
  await check("原生退出保存失败取消退出，随后普通关窗不意外退出macOS进程",async()=>{
    const s=await fresh();await s.idle();await s.edit("退出失败待保存");flags.failSaveIds=new Set(["a"]);app.quit();
    await s.until('document.getElementById("request-status").textContent.includes("关闭前保存未完成")');
    assert.equal(quitGuard.isQuitting(),false);flags.failSaveIds.clear();const done=s.closed();s.win.close();await done;
    assert.equal(quitGuard.isQuitting(),false);
  });
  const s=await fresh();await s.idle();await s.edit("最终原生退出输入");
  app.once("will-quit",()=>{
    assert.equal(entry("a").text,"最终原生退出输入");assert.equal(s.win.isDestroyed(),true);
    passed.push("原生应用退出等待页面保存，最终关闭后退出");
    require("node:fs").writeFileSync(path.join(temporary,"report.json"),JSON.stringify({passed,errors},null,2));
    console.log(`通过 ${passed.length} 项关闭页面模拟检查；截图与报告：${temporary}`);
  });
  app.quit();
}
const timeout=setTimeout(()=>{console.error("关闭检查超时");app.exit(1);},45000);
main().catch(error=>{clearTimeout(timeout);console.error(error);app.exit(1);});
