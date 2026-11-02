# 下一步：未发送侧栏与输入恢复接线

状态：页面接线候选，尚未写入实际应用或测试。你已写好上一轮的列表组件、样式和检查脚本；实际两个脚本语法检查及10项组件检查通过。样式末行另有粘贴残留，先按第0节清理，再接本步。

## 目标与取舍

继续由你亲手编写。本步修改index.html、renderer.js和page-shell.js，并新增页面离线检查脚本；复用已完成的主进程接口与列表组件。

1. 深色侧栏显示未发送列表 → 验证：启动、新建、打开历史、切换目录/项目和发送结束后刷新；忙碌期间禁用。
2. 点击条目先保存再恢复 → 验证：保存失败不调用恢复，恢复失败保留原会话、输入和文件草稿；成功后使用返回编号绑定输入，不用列表摘要回填。
3. 处理刷新与焦点 → 验证：分区刷新失败不撤回已恢复会话；列表迟到结果失效；窄窗口仅成功后收起侧栏并聚焦输入。

本步选择恢复期间暂时把输入框设为只读：原文仍可选择和复制，等待完成后恢复编辑，避免保存确认后、会话真正切换前又新增待保存输入。此限制只用于新增的未发送恢复流程，不改变生成期间继续编辑的已有行为。

列表提供手动刷新入口；普通打字自动保存不会逐字重读列表。刷新与恢复只使用编号，目录、模型和快照仍由主进程决定。有待确认发送的受阻条目保持禁用，本步不绕过底层保护。

## 0. 清理上一轮的粘贴残留

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/styles/unsent-session-list.css`。

删除当前第66行、文件末尾那一整行三个反引号。文件应以最后一条CSS规则的右花括号结束。只复制本文代码块内部，开头和结尾的Markdown围栏不属于源码。

助手保持实际应用文件未改写。由于该残留尚未由你清理，上一轮三个新文件本轮先不提交，完成后再一并核对收尾。

## 1. 接入样式和侧栏容器

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/index.html`。

在head内现有model-settings.css引用之后、结束head之前增加：

```html
  <link rel="stylesheet" href="./styles/unsent-session-list.css" />
```

在侧栏中找到现有项目入口的开始标签：

```html
      <section id="project-panel" class="project-panel" aria-labelledby="project-list-title" aria-busy="false">
```

保留它，在其前面插入：

```html
      <section id="unsent-session-list" aria-label="当前工作目录的未发送对话"></section>
```

保留最新的搜索收起按钮、项目加号入口和项目/会话分组，不恢复旧版独立项目列表。

## 2. 在renderer创建列表及恢复入口

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/renderer.js`。

在顶部createSessionList导入后增加一行：

```javascript
import { createUnsentSessionList } from "./components/unsent-session-list.js";
```

找到现有这一段的末尾：

```javascript
sessionSearch.addEventListener("input", () => {
  sessionList.setQuery(sessionSearch.value);
});
```

保留它，在其后、原const messages声明之前插入下面完整代码。不要移动原messages及之后的组件初始化：

```javascript
let unsentReadVersion = 0;
const unsentSessionList = createUnsentSessionList(
  document.getElementById("unsent-session-list"),
  openUnsentSession,
  reloadUnsentSessions,
);
unsentSessionList.setBusy(pageBusy);
window.addEventListener("pagehide", () => { unsentReadVersion += 1; }, { once: true });

// 与输入核对、文件草稿读取顺序调用，不并行争用主进程互斥入口。
async function refreshUnsentSessions() {
  const version = ++unsentReadVersion;
  const sessionId = composerState.sessionId;
  unsentSessionList.showLoading();
  try {
    const rows = await window.agent.listUnsentSessions();
    if (version !== unsentReadVersion || sessionId !== composerState.sessionId) return;
    unsentSessionList.render(rows, sessionId);
  } catch (error) {
    if (version === unsentReadVersion && sessionId === composerState.sessionId) {
      unsentSessionList.showError(error.message);
    }
  }
}

async function reloadUnsentSessions() {
  if (pageBusy) return;
  setBusy(true);
  try {
    // 手动刷新前等待当前输入落盘，使列表能包含刚保留的空会话。
    await composerPersistence.flush();
    await refreshUnsentSessions();
  } catch (error) {
    unsentSessionList.showError(error.message);
  } finally {
    setBusy(false);
  }
}

async function openUnsentSession(sessionId) {
  if (pageBusy || sessionId === composerState.sessionId) return;
  setBusy(true);
  const wasReadOnly = input.readOnly;
  // 恢复期间暂时只读，仍可选择和复制；避免离开前又产生待保存输入。
  input.readOnly = true;
  let restored = false;
  setRequestStatus("正在保存输入并恢复未发送对话……");
  try {
    await composerPersistence.flush();
    const result = await window.agent.restoreUnsentSession(sessionId);
    restored = true;
    // 主进程已确认切换，先更新消息，再绑定新编号读取完整输入与快照。
    showHistory(result.history);
    sessionList.setActive(result.sessionId);
    sessionName.value = "";
    await bindComposer(result.sessionId);
    setRequestStatus("未发送对话已恢复。请核对输入后再发送。");
    // 分区刷新失败不撤回已经完成的恢复；互斥读取依次进行。
    for (const refresh of [
      restoreProposalPanel, refreshSessions,
      () => sessionInfoPanel.refresh(), () => modelSelector.refresh(),
    ]) {
      try { await refresh(); } catch (error) {
        setRequestStatus("对话已恢复，但部分页面信息读取失败。");
        addMessage("error", `对话已恢复，刷新失败：${error.message}`);
      }
    }
  } catch (error) {
    setRequestStatus(restored ? "对话已恢复，但页面更新未完成。" : "未能恢复，原对话和输入已保留。");
    addMessage("error", `${restored ? "恢复后的页面更新失败" : "恢复未发送对话失败"}：${error.message}`);
  } finally {
    await refreshUnsentSessions();
    input.readOnly = wasReadOnly;
    setBusy(false);
    if (restored) {
      document.dispatchEvent(new CustomEvent("unsent-session-opened"));
      input.focus();
    } else document.querySelector("#unsent-session-list .unsent-list-refresh").focus();
  }
}

```

refreshUnsentSessions自身只更新列表区域，读取失败显示重试，不向调用它的已有聊天流程抛错。它使用递增读取编号和发起时的当前会话编号保护返回结果，绑定新会话或离开页面后旧读取不能再改列表。

新恢复函数在主进程成功前不清消息或文件草稿；成功后先展示返回的history，再await原bindComposer绑定返回编号。因此目标输入读取失败时，错误留在目标页面，不回填旧输入；输入区保留原有重试入口。分区刷新逐个进行，某项失败不阻止其余区域刷新。

## 3. 会话绑定时使旧列表失效

仍在renderer.js中，找到现有整个bindComposer函数，从async function bindComposer开始，到其结束花括号为止，完整替换为：

```javascript
async function bindComposer(sessionId) {
  // 会话一变就隐藏旧目录条目，并作废尚未完成的列表读取。
  unsentReadVersion += 1;
  unsentSessionList.showLoading();
  try {
    await composerPersistence.switchTo(sessionId);
  } catch (error) {
    addMessage("error", `当前对话已打开，输入读取失败：${error.message}`);
  }
}
```

上面的新增变量虽然写在该函数后面，但函数只在页面组件初始化完成后调用。保持原loadHistory()启动位置不动，避免在列表初始化前调用它。

## 4. 同步忙碌状态

在setBusy函数中找到：

```javascript
  sessionList.setBusy(busy);
```

保留它，在其后、原projectPanel.setBusy之前增加：

```javascript
  unsentSessionList.setBusy(busy);
```

这使读取、恢复、生成、文件草稿操作以及其他既有忙碌流程共用页面禁用状态。停止按钮仍沿用原generating规则。

## 5. 在现有完成位置刷新列表

以下只补一行读取，不新增第二个finally，也不替换原try/catch。

### 5.1 启动、新建、打开历史

当前renderer.js有三处以下相邻代码，分别位于loadHistory、newChatButton点击处理和openHistorySession的finally中：

```javascript
    await modelSelector.refresh();
    setBusy(false);
```

只将这三处改为：

```javascript
    await modelSelector.refresh();
    await refreshUnsentSessions();
    setBusy(false);
```

不要给其他不相邻或不在上述三个函数中的模型刷新增加重复读取。

### 5.2 发送结束

在form提交处理的finally末尾，找到原来这三行：

```javascript
    await sessionInfoPanel.refresh();
    setBusy(false);
    input.focus();
```

替换为：

```javascript
    await sessionInfoPanel.refresh();
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
```

这里仍位于原流式收尾与监听清理之后，覆盖请求成功、失败和主动停止，不恢复旧发送输入。

### 5.3 项目打开

在openProject内部，找到原Promise.allSettled调用后的这一行：

```javascript
  const failures = updates.filter((update) => update.status === "rejected");
```

保留它，在它前面增加：

```javascript
  await refreshUnsentSessions();
```

这次读取必须放在整个Promise.allSettled已经await完成之后，不能加入它的数组。listUnsentSessions、listProposals和inspectComposerSend共用互斥入口，并行会互相拒绝。

### 5.4 工作目录选择

在文件末尾selectWorkspaceButton点击处理的finally中，将原来的：

```javascript
  } finally {
    setBusy(false);
    input.focus();
  }
```

替换为：

```javascript
  } finally {
    await refreshUnsentSessions();
    setBusy(false);
    input.focus();
  }
```

只改这个目录选择处理器的finally。取消或失败时列表仍按实际原目录读取；成功时先由原bindComposer使旧结果失效，再刷新新目录列表。

## 6. 窄窗口恢复成功后返回聊天

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/components/page-shell.js`。

在文件末尾追加以下完整代码：

```javascript
// 只在业务确认恢复成功后收起窄窗口侧栏，失败时保留重试入口。
document.addEventListener("unsent-session-opened", () => {
  if (narrowWindow.matches) setSidebar(false);
});
```

该事件由新增恢复入口在主进程已确认切换、页面收尾后发出。失败时不派发，侧栏保留；外壳继续只管展示，不调用业务接口。

## 7. 新建离线页面检查脚本

新建 `/Users/liyingjun/Desktop/SW-QA/17-00/tests/ui/unsent-session-page.check.cjs`，完整内容如下。

它加载实际index.html、renderer、外壳和实际preload/IPC，模拟会话、输入存储与模型回调。userData、截图与报告都放临时目录，不读真实配置或会话，禁用HTTP/HTTPS。测试内主动制造的失败只发生在模拟接口中，无须破坏真实配置或请求模型。

```javascript
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
  const idle=() => until('!document.getElementById("new-chat-button").disabled && !document.querySelector(".unsent-list-refresh").disabled');
  const click=selector => js(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const edit=text => js(`document.getElementById("message-input").value=${JSON.stringify(text)};document.getElementById("message-input").dispatchEvent(new Event("input"));`);
  const open=id => click(`[data-unsent-id="${id}"]`);
  const passed=[];
  const check=async (name,fn) => { await fn();passed.push(name);console.log("通过",name); };
  await idle();
  await check("启动列表和输入/草稿读取依次完成",async () => {
    assert.equal(await js('document.getElementById("message-input").value'),"原输入");
    assert.equal(await js('document.querySelectorAll("#unsent-session-list .unsent-list-open").length'),3);
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
    assert.equal(await js('document.querySelector("[data-unsent-id=b]").getAttribute("aria-current")'),"true");
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
  await check("未发送列表失败显示重试且不破坏聊天",async () => {
    flags.list=true; await click(".unsent-list-refresh"); await idle();
    assert.match(await js('document.querySelector(".unsent-list-status").textContent'),/读取未完成/);
    assert.equal(await js('document.querySelector(".unsent-list-refresh").textContent'),"重试");
    await click(".unsent-list-refresh"); await idle();
    assert.equal(await js('document.querySelector(".unsent-list-refresh").textContent'),"刷新");
  });
  await check("手动刷新先保存输入且不替换当前消息与草稿节点",async () => {
    await edit("刷新前输入");
    await js('window.savedMessage=document.getElementById("messages").firstChild; window.savedProposal=document.getElementById("proposal-list").firstChild;');
    await click(".unsent-list-refresh"); await idle();
    assert.equal(entry("b").text,"刷新前输入");
    assert.equal(await js('savedMessage===document.getElementById("messages").firstChild && savedProposal===document.getElementById("proposal-list").firstChild'),true);
  });
  await check("新建后刷新未发送条目且不回填旧输入",async () => {
    await click("#new-chat-button"); await idle();
    assert.match(current,/new-/); assert.equal(await js('document.getElementById("message-input").value'),"");
    assert.equal(await js('document.querySelectorAll("#unsent-session-list [aria-current]").length'),0);
  });
  await check("目录切换清旧列表，项目打开恢复同目录列表",async () => {
    await click("#select-workspace-button"); await idle();
    assert.equal(workspace,"/qa/two");
    assert.equal(await js('document.querySelectorAll(".unsent-list-open").length'),0);
    await click(".session-project-open"); await idle();
    assert.equal(workspace,"/qa/one");
    assert.equal(await js('document.querySelectorAll(".unsent-list-open").length'),3);
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
    assert.equal(await js('[...document.querySelectorAll("#unsent-session-list button")].every(b=>b.disabled)'),true);
    await click("#stop-button"); await idle();
    assert.equal(await js('document.getElementById("message-input").value'),"");
    assert.equal(await js('document.getElementById("stop-button").disabled'),true);
  });
  await check("列表迟到结果在页面离开后失效",async () => {
    const gate=Promise.withResolvers(); flags.listGate=gate;
    await click(".unsent-list-refresh"); await until('document.querySelector(".unsent-list-refresh").disabled');
    await new Promise(r=>setTimeout(r,30));
    await js('window.dispatchEvent(new Event("pagehide")); document.querySelector(".unsent-list-status").textContent="已离开页面";');
    gate.resolve(); await until('!document.getElementById("new-chat-button").disabled');
    assert.equal(await js('document.querySelector(".unsent-list-status").textContent'),"已离开页面");
  });
  await fs.writeFile(path.join(temporary,"report.json"),JSON.stringify({passed,errors},null,2));
  console.log(`通过 ${passed.length} 项实际页面模拟检查；截图与报告：${temporary}`); win.destroy();
}
const timeout=setTimeout(()=>app.exit(1),45000);
main().then(()=>{clearTimeout(timeout);app.quit();}).catch(e=>{console.error(e);app.exit(1);});
```

## 8. 验证与界面核对

在项目根目录执行：

```bash
node --check src/renderer/renderer.js
node --check src/renderer/components/page-shell.js
node --check tests/ui/unsent-session-page.check.cjs
./node_modules/.bin/electron tests/ui/unsent-session-list.check.cjs
./node_modules/.bin/electron tests/ui/unsent-session-page.check.cjs
```

预期组件检查10项、实际页面模拟19项全部通过。页面脚本会打印主动模拟的失败消息；以最终通过数量及正常退出为准，断言失败或超时会失败退出。它会给出临时截图和report.json位置。原生textarea会将CRLF展示为LF，测试按浏览器既有规则比较展示内容，没有为本步修改输入存储。

本候选已在实际渲染层临时副本 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-unsent-page-latest-2mr2rdtj` 通过三个脚本语法检查与19项页面模拟。报告及三档截图位于 `/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/unsent-page-ui-tXEEYB`，截图已查看；候选中的样式末尾残留已单独清理，实际文件仍待你清理。模拟验证不能代替真实重启验收，也不代表工作区其他未提交功能已经验收。

然后运行npm start，使用你自己的非敏感测试输入核对：

1. 在空会话中输入中文、多行及前后空格，等待“输入已保存”，点击未发送区刷新，确认当前条目标记正确。
2. 新建另一空会话输入不同内容，依次恢复两条未发送记录，确认输入不串、模型正确、没有自动发送；已有文件草稿切走再回来仍在。
3. 等待输入已保存后正常退出并重启，通过同目录未发送入口找回原输入。此处只核对已确认落盘的内容，关闭前补保存仍是下一项工作。
4. 缩窄窗口，恢复成功后回到聊天并聚焦输入；受阻条目显示原因且不可恢复。不要为测试强行制造真实待确认发送或破坏目录/模型配置，异常已由离线脚本覆盖。

用户真实验收完成后再记录具体结果。正常关闭前补保存、无历史待确认发送记录的专用处理入口仍未完成，不称完整重启恢复。
