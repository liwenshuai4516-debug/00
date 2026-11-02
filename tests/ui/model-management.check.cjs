const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, writeFile, rm } = require("node:fs/promises");
const { app, BrowserWindow, ipcMain, safeStorage } = require("electron");
const { createModelSettingsStore } = require("../../src/main/storage/model-settings-store.js");
const { createModelCredentialsStore } = require("../../src/main/storage/model-credentials-store.js");
const { createModelSettingsService, createSettingsCatalog } = require("../../src/main/services/model-settings-service.js");
const { registerAgentIpc } = require("../../src/main/ipc/agent-ipc.js");
app.disableHardwareAcceleration();
app.on("window-all-closed", () => {});

async function main() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "model-management-ui-"));
  const userData = path.join(temporary, "user-data");
  await mkdir(path.join(userData, "Shared Dictionary", "cache"), { recursive: true });
  app.setPath("userData", userData); app.setPath("sessionData", userData);
  process.env.PI_CODING_AGENT_DIR = path.join(temporary, "pi");
  process.env.PI_OFFLINE = "1";
  await app.whenReady();
  assert.ok(safeStorage.isEncryptionAvailable(), "测试需要系统加密可用");
  const store = createModelSettingsStore(path.join(temporary, "settings.json"), safeStorage, {});
  const credentials = createModelCredentialsStore(path.join(temporary, "credentials.json"), safeStorage);
  const catalog = await createSettingsCatalog();
  let officialRefreshes = 0, authRefreshes = 0, fetches = 0;
  const originalRefresh = catalog.refresh.bind(catalog);
  catalog.refresh = options => { if (options.allowNetwork) { officialRefreshes++; return Promise.resolve({ aborted: false, errors: new Map() }); } return originalRefresh(options); };
  const fakeAuthRuntime = {
    getProvider: provider => catalog.getProvider(provider),
    refresh: async options => { if (options.allowNetwork) officialRefreshes++; return { aborted: false, errors: new Map() }; }, hasConfiguredAuth: provider => provider === "deepseek", isUsingOAuth: () => false,
    async login(provider, _type, interaction) {
      interaction.notify({ type: "auth_url", url: "https://example.invalid/login", instructions: "测试授权" });
      const reply = await interaction.prompt({ type: "text", message: "输入测试授权码" });
      assert.equal(reply, "test-code");
      await credentials.modify(provider, async () => ({ type: "oauth", access: "test-access", refresh: "test-refresh", expires: Date.now() + 3600000 }));
    }, logout: provider => credentials.logout(provider),
  };
  const settings = createModelSettingsService(store, async () => catalog, {
    credentialsStore: credentials, createRuntime: async () => fakeAuthRuntime,
    openExternal: async url => { assert.equal(url, "https://example.invalid/login"); },
    fetch: async url => {
      fetches++;
      if (url.includes("openrouter.ai")) return { ok: true, json: async () => ({ data: [{ id: "vendor/test-model", context_length: 64000, top_provider: { max_completion_tokens: 4000 } }] }) };
      return { ok: true, json: async () => ({ data: [{ id: "test-model" }, { id: "new-model" }] }) };
    },
  });
  const input = { name: "初始配置", kind: "custom", provider: "gateway", modelId: "test-model", baseUrl: "https://example.invalid/v1", authMode: "saved", apiKey: "test-placeholder", api: "openai-completions", contextWindow: 32000, maxTokens: 2000 };
  const initial = await settings.save(input);
  let current = initial.id, thinking = "off", draft = { sessionId: "test-session", text: "保留聊天输入", revision: 1 };
  const sessions = {
    loadHistory: async () => [], currentSession: async () => "test-session", listSessions: async () => [], listUnsentSessions: async () => [],
    getSessionInfo: async () => ({ sessionId: "test-session", workspaceDir: "/demo", provider: "gateway", modelId: "test-model", thinkingLevel: thinking, thinkingLevels: ["off", "low", "high"] }),
    listModelProfiles: async () => ({ ...await store.read(current), currentProfileId: current }),
    switchModelProfile: async id => { await store.loadProfile(id); current = id; },
    setThinkingLevel: async value => { assert.ok(["off", "low", "high"].includes(value)); thinking = value; },
    refreshModelAuth: async () => { authRefreshes++; },
  };
  registerAgentIpc(ipcMain, sessions, { isBusy: () => false, listProposals: async () => [] }, {}, {}, {}, {}, { listProjects: async () => [] }, {
    loadCurrentDraft: async () => draft,
    saveDraft: async (id, text, revision) => (draft = { sessionId: id, text, revision: revision + 1 }),
    inspectSend: async () => ({ ...draft, pendingSend: null }),
  }, settings);
  const win = new BrowserWindow({ width: 1280, height: 860, show: false,
    webPreferences: { preload: path.resolve(__dirname, "../../src/preload/preload.js"), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.session.webRequest.onBeforeRequest({ urls: ["http://*/*", "https://*/*"] }, (_details, done) => done({ cancel: true }));
  const errors = [];
  win.webContents.on("console-message", event => { if (event.level === "error") errors.push(event.message); });
  const run = source => win.webContents.executeJavaScript(source);
  const wait = expression => run(`(async()=>{for(let i=0;i<400;i++){if(${expression})return;await new Promise(r=>setTimeout(r,10));}throw Error('等待失败: '+${JSON.stringify(expression)});})()`);
  const click = selector => run(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const change = (selector, value) => run(`{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('change',{bubbles:true}));}`);
  const fill = (selector, value) => run(`document.querySelector(${JSON.stringify(selector)}).value=${JSON.stringify(value)}`);
  let passed = 0;
  const check = async (label, expression) => { assert.ok(await run(expression), label); console.log("PASS " + label); passed++; };
  const idle = () => wait(`!document.querySelector('[data-saved-controls]').disabled && document.querySelector('#model-settings-dialog').getAttribute('aria-busy')==='false'`);
  try {
    await win.loadFile(path.resolve(__dirname, "../../src/renderer/index.html"));
    await wait(`!document.querySelector('#model-settings-button').disabled`);
    await run(`window.confirm=()=>true;window.prompt=()=>"复制的配置";undefined`);
    await click("#model-settings-button"); await idle();
    await check("设置读取使用真实预加载与IPC，保留聊天输入", `document.querySelector('#saved-model-profiles').options.length===2 && document.querySelector('#message-input').value==='保留聊天输入'`);
    await click("[data-edit]"); await idle();
    await fill("#profile-name", "编辑后的配置");
    await run(`document.querySelector('.new-profile-editor form').requestSubmit()`); await idle();
    const edited = (await store.read()).profiles[0];
    assert.notEqual(edited.id, initial.id); assert.equal((await store.loadProfile(edited.id)).apiKey, input.apiKey);
    await check("编辑不回显密钥，旧会话模型仍保留", `document.querySelector('#profile-key').value==='' && document.querySelector('#model-select').value===${JSON.stringify(initial.id)}`);
    await click("[data-apply]"); await idle(); assert.equal(current, edited.id);
    await click("[data-clone]"); await idle();
    assert.equal((await store.read()).profiles.length, 2);
    await click("[data-default]"); await idle();
    const defaultId = (await store.read()).defaultProfileId;
    assert.notEqual(defaultId, current);
    await check("设置默认不切换当前对话，不丢聊天输入", `document.querySelector('#model-select').value===${JSON.stringify(current)} && document.querySelector('#message-input').value==='保留聊天输入'`);
    await click("[data-edit]"); await idle();
    await click("[data-fetch-models]"); await idle();
    await check("编辑留空密钥可获取目录", `document.querySelector('#profile-model-options').options.length===2`);
    await click("[data-test-connection]"); await idle();
    await check("测试仅提示列表连接结果", `document.querySelector('[data-model-status]').textContent.includes('列表连接成功')`);
    await click("[data-refresh-profile]"); await idle();
    await check("刷新目录包含新模型", `document.querySelector('[data-profile-catalog]').textContent.includes('new-model')`);
    await fill("#profile-context", ""); await fill("#profile-max-tokens", "");
    await click("[data-enrich]");
    await wait(`document.querySelector('[data-enrich-results] button')`);
    await click("[data-enrich-results] button");
    await check("公开目录参数明确来源并补充空白字段", `document.querySelector('[data-enrich-results]').textContent.includes('OpenRouter') && document.querySelector('#profile-context').value==='64000'`);
    await change("#model-thinking-level", "high"); await idle(); assert.equal(thinking, "high");
    await change("#auth-provider", "gateway"); await wait(`!document.querySelector('#provider-key-value').disabled`);
    await fill("#provider-key-name", "密钥一"); await fill("#provider-key-value", "placeholder-1");
    await run(`document.querySelector('[data-provider-auth] form').requestSubmit()`); await idle();
    await wait(`document.querySelectorAll('.provider-key-row').length===1`);
    await fill("#provider-key-name", "密钥二"); await fill("#provider-key-value", "placeholder-2");
    await run(`document.querySelector('[data-provider-auth] form').requestSubmit()`); await idle();
    await wait(`document.querySelectorAll('.provider-key-row').length===2`);
    await run(`document.querySelectorAll('.provider-key-row')[1].querySelector('button').click()`); await idle();
    assert.equal((await credentials.state("gateway")).credential.key, "placeholder-2");
    await run(`document.querySelectorAll('.provider-key-row')[1].querySelectorAll('button')[1].click()`); await idle();
    assert.equal((await credentials.state("gateway")).credential, undefined);
    await check("密钥激活和删除同步会话状态，页面不显示密钥", `!document.querySelector('[data-provider-auth]').textContent.includes('placeholder-') && document.querySelector('#provider-key-value').value===''`);
    assert.equal(authRefreshes, 4);
    await change("#auth-provider", "openai-codex"); await wait(`!document.querySelector('[data-login]').disabled`);
    await click("[data-login]"); await idle();
    await wait(`document.querySelector('#provider-oauth-response')`);
    await click("[data-oauth-flow] button");
    await click("[data-close]"); await click("#model-settings-button"); await idle();
    await wait(`document.querySelector('#provider-oauth-response')`);
    await check("重开设置恢复进行中的授权提示", `document.querySelector('[data-oauth-flow]').textContent.includes('输入测试授权码')`);
    await fill("#provider-oauth-response", "test-code");
    await run(`document.querySelector('#provider-oauth-response').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true,cancelable:true}))`);
    await wait(`document.querySelector('[data-auth-status]').textContent.includes('OAuth 登录')`);
    assert.equal((await credentials.state("openai-codex")).credential.access, "test-access");
    await click("[data-logout]"); await idle(); assert.equal((await credentials.state("openai-codex")).credential, undefined);
    await click("[data-login]"); await idle(); await wait(`document.querySelector('#provider-oauth-response')`);
    await run(`Array.from(document.querySelectorAll('[data-oauth-flow] button')).find(b=>b.textContent==='取消登录').click()`);
    await wait(`document.querySelector('[data-oauth-flow]').textContent.includes('已取消')`);
    await check("登录、退出、取消均接通事件链路", `!document.querySelector('#provider-oauth-response')`);
    await change("#catalog-provider", "deepseek");
    await click("[data-refresh-builtin]"); await idle(); assert.equal(officialRefreshes, 1);
    await run(`document.querySelector('[data-catalog-tools] details').open=true`);
    await fill("#catalog-model-id", "manual-test-model"); await fill("#catalog-context", "64000"); await fill("#catalog-max-tokens", "4000");
    await run(`document.querySelector('[data-append-model]').requestSubmit()`); await idle();
    assert.ok((await settings.listModels("deepseek")).some(model => model.id === "manual-test-model"));
    for (const width of [1280, 390]) {
      win.setSize(width, 860);
      await run(`document.querySelector('.settings-content').scrollTop=0;new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))`);
      await check(`设置${width}宽度无横向溢出`, `document.querySelector('.settings-content').scrollWidth<=document.querySelector('.settings-content').clientWidth+1 && document.querySelector('#model-settings-dialog').getBoundingClientRect().right<=innerWidth`);
      if (process.env.MODEL_UI_ARTIFACT_DIR) {
        await mkdir(process.env.MODEL_UI_ARTIFACT_DIR, { recursive: true });
        await writeFile(path.join(process.env.MODEL_UI_ARTIFACT_DIR, `settings-${width}.png`), (await win.webContents.capturePage()).toPNG());
      }
    }
    await click("[data-close]");
    await check("关闭恢复原聊天和输入操作", `!document.querySelector('#model-settings-dialog').open && document.querySelector('#message-input').value==='保留聊天输入' && !document.querySelector('#message-input').disabled`);
    assert.ok(fetches >= 4); assert.deepEqual(errors, []);
    console.log(`模型管理 ${passed} 项页面检查通过。`);
  } finally { settings.oauth.dispose(); settings.enrichment.dispose(); win.destroy(); await rm(temporary, { recursive: true, force: true }); }
}
main().then(() => app.quit()).catch(error => { console.error(error); app.exit(1); });
