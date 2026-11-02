const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const { mkdtempSync, mkdirSync } = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const temporary = mkdtempSync(path.join(os.tmpdir(), "unsent-page-ui-"));
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
let current = "a", workspace = "/qa/one", serial = 0, generating = false, runningGate;
const history = id => id === "b" ? [] : [{ role: "user", text: `保留消息 ${id}` }];
const failure = name => { if (flags[name]) { flags[name] = false; throw Error(`模拟${name}失败`); } };
const pause = async name => { if (flags[name]) { const gate = flags[name]; flags[name] = null; await gate.promise; } };
const session = {
  loadHistory: async () => history(current), currentSession: async () => current,
  getSessionInfo: async () => ({ sessionId: current, workspaceDir: workspace, modelId: current === "b" ? "Pro" : "Flash", provider: "mock", contextUsage: null }),
  listModelProfiles: async () => ({ currentProfileId: current === "b" ? "pro" : "flash", profiles: [{ id:"flash", name:"Flash", provider:"mock", modelId:"Flash" },{ id:"pro",name:"Pro",provider:"mock",modelId:"Pro" }] }),
  listSessions: async () => { failure("historyList"); return []; },
  listUnsentSessions: async () => {
    calls.push(["list",current,workspace]); await pause("listGate"); failure("list");
    if (workspace !== "/qa/one") return [];
    return ["a","b","c"].filter(id => id === "c" || entry(id).text.length).map(id => ({ id, title:id === "c" ? "待确认输入" : `摘要 ${id}`, workspaceDir:workspace, blockedReason:id === "c" ? "仍有待确认发送，暂不能重建。" : "" }));
  },
  restoreUnsentSession: async id => {
    calls.push(["restore",id,entry(current).text]); await pause("restoreGate"); failure("restore");
    assert.notEqual(id,"c"); current=id; return { sessionId:id,workspaceDir:workspace,history:history(id) };
  },
  openSession: async id => { current=id; return history(id); },
  newChat: async () => { current=`new-${++serial}`; return current; },
  renameSession: async () => {},
  compactSession: async () => ({ history:history(current) }),
  cancelCompaction: async () => {},
  previewSession: async id => ({ history:history(id) }),
};
const composer = {
  loadCurrentDraft: async () => { calls.push(["load",current]); failure("load"); return { ...entry(current) }; },
  inspectSend: async id => { calls.push(["inspect",id]); return { ...entry(id), pendingSend:null }; },
  saveDraft: async (id,text,revision) => {
    calls.push(["save",id,text]); await pause("saveGate"); failure("save");
    assert.equal(revision,entry(id).revision); Object.assign(entry(id), { text,revision:revision+1 }); return { ...entry(id) };
  },
};
const chat = {
  isBusy: () => generating,
  listProposals: async () => { calls.push(["proposals",current]); failure("proposals"); return [{ id:`proposal-${current}` }]; },
  async send(text,onText,onTool,onStatus,draft,onAck) {
    generating=true; entry(current).text=""; entry(current).revision++;
    const ack={ sessionId:current,text:"",revision:entry(current).revision,sendId:"send-1" }; onAck(ack); onText("模拟回复");
    runningGate=flags.sendGate; await pause("sendGate"); generating=false; return { outcome:"completed",stopped:true,draft:ack };
  },
  stop: async () => { runningGate?.resolve(); },
};
registerAgentIpc(ipcMain,session,chat,{}, {}, { exportConversation:async () => ({ canceled:true }) },
  { selectWorkspace:async () => { workspace="/qa/two"; current="other"; return { sessionId:current,workspaceDir:workspace }; } },
  { listProjects:async () => [{ id:"p",name:"测试项目",workspaceDir:"/qa/one" }],openProject:async () => { workspace="/qa/one"; current="a"; return { sessionId:current,history:history(current) }; },addProject:async () => ({ canceled:true }) },composer,{});

async function main() {
  await app.whenReady();
  const win=new BrowserWindow({ width:1120,height:820,show:false,webPreferences:{ preload:path.join(root,"src/preload/preload.js"),contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls:["http://*/*","https://*/*"] },(_d,done)=>done({cancel:true}));
  const errors=[];
  win.webContents.on("console-message", details => { if (details.level === "error") errors.push(details.message); });
  await win.loadFile(path.join(root,"src/renderer/index.html"));
  const js=code => win.webContents.executeJavaScript(code);
  const until=async code => {
    const end=Date.now()+5000;
    while (!await js(code)) { if(Date.now()>end) throw Error(`等待超时：${code}`); await new Promise(r=>setTimeout(r,20)); }
  };
  const idle=() => until('!document.getElementById("new-chat-button").disabled');
  const click=selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const edit=text => js(`document.getElementById("message-input").value=${JSON.stringify(text)};document.getElementById("message-input").dispatchEvent(new Event("input"));`);
  const open=id => click(`#session-list .session-open[data-session-id="${id}"]`);
  const passed=[];
  const check=async (name,fn) => { await fn();passed.push(name);console.log("通过",name); };
  await idle();
  await check("启动列表和输入/草稿读取依次完成",async () => {
    assert.equal(await js('document.getElementById("message-input").value'),"原输入");
    assert.equal(await js('document.querySelectorAll("#session-list [data-empty-session]").length'),3);
    assert(calls.findIndex(c=>c[0]==="inspect")<calls.findIndex(c=>c[0]==="proposals"));
    assert(calls.findIndex(c=>c[0]==="proposals")<calls.findIndex(c=>c[0]==="list"));
    assert(!errors.some(e=>e.includes("其他操作完成")));
  });
  await check("输入读取失败仍绑定已恢复的编号，重试读取目标输入",async () => {
    flags.load=true; await open("b"); await idle();
    assert.equal(current,"b");
    assert.match(await js('document.getElementById("composer-draft-status").textContent'),/未完成核对/);
    assert.equal(await js('document.getElementById("send-button").disabled'),true);
    assert.match(await js('document.getElementById("messages").textContent'),/输入读取失败/);
    await click("#composer-draft-retry"); await idle();
    assert.equal(await js('document.getElementById("message-input").value'),entry("b").text.replace(/\r\n/g,"\n"));
    await open("a"); await idle();
  });
  await check("当前项不重复恢复",async () => {
    const count=calls.filter(c=>c[0]==="restore").length;
    await open("a"); assert.equal(calls.filter(c=>c[0]==="restore").length,count);
  });
  await check("受阻项不恢复，标题不作为原文",async () => {
    const count=calls.filter(c=>c[0]==="restore").length;
    await open("c"); assert.equal(calls.filter(c=>c[0]==="restore").length,count);
    await edit("离开前最新输入"); await open("b"); await idle();
    assert.equal(current,"b"); assert.equal(entry("a").text,"离开前最新输入");
    assert.equal(await js('document.getElementById("message-input").value'),entry("b").text.replace(/\r\n/g,"\n"));
    assert.equal(await js('document.querySelector(".session-open[data-session-id=b]").getAttribute("aria-current")'),"true");
    assert.equal(await js('document.getElementById("model-select").value'),"pro");
    assert.equal(await js('document.querySelectorAll("#proposal-list article").length'),1);
  });
  await check("恢复原会话保留输入和文件草稿",async () => {
    await open("a"); await idle();
    assert.equal(await js('document.getElementById("message-input").value'),"离开前最新输入");
    assert.equal(await js('document.querySelectorAll("#proposal-list article").length'),1);
  });
  await check("保存未确认前不恢复，期间只读并阻止重复操作",async () => {
    await edit("等待落盘原文"); const gate=Promise.withResolvers(); flags.saveGate=gate;
    const count=calls.filter(c=>c[0]==="restore").length;
    await open("b"); await until('document.getElementById("message-input").readOnly');
    await open("b");
    assert.equal(calls.filter(c=>c[0]==="restore").length,count);
    assert.equal(await js('document.getElementById("new-chat-button").disabled'),true);
    gate.resolve(); await idle(); assert.equal(current,"b");
    assert.equal(entry("a").text,"等待落盘原文");
    assert.equal(await js('document.getElementById("message-input").readOnly'),false);
  });
  await check("保存失败保留原编号/输入/消息/草稿且不调用恢复",async () => {
    await edit("不能丢的输入"); flags.save=true;
    const count=calls.filter(c=>c[0]==="restore").length;
    const proposals=await js('document.getElementById("proposal-list").innerHTML');
    await open("a"); await idle();
    assert.equal(current,"b"); assert.equal(calls.filter(c=>c[0]==="restore").length,count);
    assert.equal(await js('document.getElementById("message-input").value'),"不能丢的输入");
    assert.equal(await js('document.getElementById("proposal-list").innerHTML'),proposals);
    assert.equal(await js('document.getElementById("message-input").readOnly'),false);
    await click("#composer-draft-retry"); await idle();
  });
  await check("恢复拒绝后保留原展示，允许显式重试",async () => {
    flags.restore=true; const text=await js('document.getElementById("message-input").value');
    await open("a"); await idle(); assert.equal(current,"b");
    assert.equal(await js('document.getElementById("message-input").value'),text);
    assert.match(await js('document.getElementById("request-status").textContent'),/原对话和输入已保留/);
    await open("a"); await idle(); assert.equal(current,"a");
  });
  await check("恢复已成功但历史或草稿刷新失败不能回退原会话",async () => {
    flags.proposals=true; flags.historyList=true;
    await open("b"); await idle(); assert.equal(current,"b");
    assert.equal(await js('document.getElementById("message-input").value'),"不能丢的输入");
    assert.match(await js('document.getElementById("request-status").textContent'),/已恢复/);
    assert.match(await js('document.getElementById("messages").textContent'),/刷新失败/);
  });
  await check("空对话并入统一列表，读取失败可重试且不破坏聊天",async () => {
    flags.list=true; await click("#new-chat-button"); await idle();
    assert.match(await js('document.querySelector(".session-list-status").textContent'),/读取失败/);
    assert.equal(await js('document.querySelector(".session-list-retry").hidden'),false);
    await click(".session-list-retry"); await idle();
    assert.equal(await js('document.querySelector(".session-list-retry").hidden'),true);
  });
  await check("新建后刷新未发送条目且不回填旧输入",async () => {
    await click("#new-chat-button"); await idle();
    assert.match(current,/new-/); assert.equal(await js('document.getElementById("message-input").value'),"");
    assert.equal(await js('document.querySelectorAll("#session-list [aria-current]").length'),0);
  });
  await check("目录切换清旧列表，项目打开恢复同目录列表",async () => {
    await click("#select-workspace-button"); await idle();
    assert.equal(workspace,"/qa/two");
    assert.equal(await js('document.querySelectorAll("[data-empty-session]").length'),0);
    await click(".session-project-open"); await idle();
    assert.equal(workspace,"/qa/one");
    assert.equal(await js('document.querySelectorAll("[data-empty-session]").length'),3);
  });
  await check("窄窗口恢复成功才关闭侧栏，失败保持入口",async () => {
    win.setContentSize(375,760); await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
    await click("#sidebar-toggle"); flags.restore=true; await open("b"); await idle();
    assert.equal(await js('document.getElementById("app-sidebar").hidden'),false);
    await open("b"); await idle();
    assert.equal(await js('document.getElementById("app-sidebar").hidden'),true);
    assert.equal(await js('document.activeElement.id'),"message-input");
  });
  for(const width of [1120,760,375]) {
    await check(`${width}宽度实际页面无横向溢出`,async () => {
      win.setContentSize(width,820); await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      if(await js('document.getElementById("app-sidebar").hidden')) await click("#sidebar-toggle");
      await js('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))');
      assert.equal(await js('document.documentElement.scrollWidth <= innerWidth + 1'),true);
      await fs.writeFile(path.join(temporary,`page-${width}.png`),(await win.webContents.capturePage()).toPNG());
    });
  }
  await check("生成中禁用未发送入口，停止后恢复并刷新",async () => {
    // 窄窗口先返回聊天，发送仅使用模拟回调，不请求模型。
    if(!await js('document.getElementById("app-sidebar").hidden')) await click("#sidebar-close");
    const gate=Promise.withResolvers(); flags.sendGate=gate;
    await edit("模拟发送原文"); await click("#send-button");
    await until('!document.getElementById("stop-button").disabled');
    assert.equal(await js('[...document.querySelectorAll("#session-list button")].every(b=>b.disabled)'),true);
    await click("#stop-button"); await idle();
    assert.equal(await js('document.getElementById("message-input").value'),"");
    assert.equal(await js('document.getElementById("stop-button").disabled'),true);
  });
  await check("列表迟到结果在页面离开后失效",async () => {
    const gate=Promise.withResolvers(); flags.listGate=gate;
    await click("#new-chat-button"); await until('document.querySelector("#new-chat-button").disabled');
    await new Promise(r=>setTimeout(r,30));
    await js('window.dispatchEvent(new Event("pagehide")); document.querySelector(".session-list-status").textContent="已离开页面";');
    gate.resolve(); await until('!document.getElementById("new-chat-button").disabled');
    assert.equal(await js('document.querySelector(".session-list-status").textContent'),"已离开页面");
  });
  await fs.writeFile(path.join(temporary,"report.json"),JSON.stringify({passed,errors},null,2));
  console.log(`通过 ${passed.length} 项实际页面模拟检查；截图与报告：${temporary}`); win.destroy();
}
const timeout=setTimeout(()=>app.exit(1),45000);
main().then(()=>{clearTimeout(timeout);app.quit();}).catch(e=>{console.error(e);app.exit(1);});