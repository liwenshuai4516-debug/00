const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { mkdtemp, mkdir, rm } = require("node:fs/promises");
const runFile = promisify(execFile);

test("真实SDK多配置即时切换、同名模型隔离、历史分支与默认恢复", async (t) => {
  const base = await mkdtemp(path.join(os.tmpdir(), "model-profiles-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  await mkdir(workspace);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict");
    const path = require("node:path");
    const { readFile, writeFile } = require("node:fs/promises");
    const { createModelSettingsStore, PROFILE_PREFIX } = require(${JSON.stringify(root + "/src/main/storage/model-settings-store.js")});
    const { createModelSettingsService } = require(${JSON.stringify(root + "/src/main/services/model-settings-service.js")});
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    globalThis.fetch = async () => assert.fail("测试不得请求网络或模型");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(root + "/src/main/pi-agent.mjs")});
      const base = process.argv[1];
      // 测试使用占位凭据和可逆编码；实际应用由 Electron safeStorage 加密。
      const store = createModelSettingsStore(path.join(base, "settings.json"), {
        isEncryptionAvailable: () => true,
        encryptString: value => Buffer.from(value), decryptString: buffer => buffer.toString(),
      }, {PI_PROVIDER:"deepseek", PI_MODEL:"deepseek-flash"});
      const settings = createModelSettingsService(store);
      const input = {name:"A",kind:"custom",provider:"同名供应商",modelId:"same-model",baseUrl:"https://a.example.invalid/v1",authMode:"saved",apiKey:"placeholder-A",api:"openai-completions",contextWindow:32000,maxTokens:2000};
      const a = await settings.save(input);
      const b = await settings.save({...input,name:"B",baseUrl:"https://b.example.invalid/v1",apiKey:"placeholder-B"});
      const c = await settings.save({...input,name:"C",api:"anthropic-messages"});
      const d = await settings.save({...input,name:"D",api:"openai-responses"});
      const sdk = await settings.save({...input,name:"SDK",kind:"builtin",provider:"deepseek",modelId:"deepseek-flash",baseUrl:"",authMode:"sdk"});
      await settings.setDefault(a.id);
      const create = (...args) => createPiAgent(...args, settings);
      const dir = path.join(base, "sessions");
      const makeService = () => createSessionService(dir, create, () => process.env.AGENT_WORKSPACE_DIR);
      const service = makeService();
      const session = await service.getSession();
      assert.equal(session.model.provider, PROFILE_PREFIX+a.id);
      const id = session.sessionId;
      const file = session.sessionFile;
      const message = {role:"user",content:"临时测试上下文",timestamp:Date.now()};
      session.sessionManager.appendMessage(message);
      session.agent.state.messages.push(message);
      const messages = JSON.stringify(session.messages);
      const branchPoint = session.sessionManager.getBranch().find(entry=>entry.type==="model_change").id;
      await service.switchModelProfile(b.id);
      assert.equal(session.sessionId,id);
      assert.equal(JSON.stringify(session.messages),messages);
      assert.equal(session.model.baseUrl,input.baseUrl.replace("a.example","b.example"));
      const auth = await session.modelRuntime.getAuth(session.model);
      assert.ok(auth.auth.apiKey === "placeholder-B");
      const aModel=session.modelRuntime.getModel(PROFILE_PREFIX+a.id,input.modelId);
      assert.ok((await session.modelRuntime.getAuth(aModel)).auth.apiKey === "placeholder-A");
      assert.equal(aModel.baseUrl,input.baseUrl);
      assert.equal((await service.listModelProfiles()).currentProfileId,b.id);
      const info=await service.getSessionInfo();
      assert.equal(info.profileName,"B");assert.equal(info.provider,input.provider);
      await settings.setDefault(a.id);
      assert.equal(session.model.provider,PROFILE_PREFIX+b.id);
      session.dispose();
      const reopenedService=makeService();
      await reopenedService.openSession(id);
      const reopened=await reopenedService.getSession();
      assert.equal(reopened.model.provider,PROFILE_PREFIX+b.id);
      assert.equal(reopened.messages[0].content,"临时测试上下文");
      reopened.dispose();
      const resumed=await makeService().getSession(true);
      assert.equal(resumed.model.provider,PROFILE_PREFIX+b.id);
      const fresh=await makeService().getSession();
      assert.equal(fresh.model.provider,PROFILE_PREFIX+a.id);fresh.dispose();
      // 分支只恢复当前分支选择。
      resumed.sessionManager.branch(branchPoint);
      resumed.sessionManager.appendMessage({role:"user",content:"分支测试",timestamp:Date.now()});
      resumed.dispose();
      const branchedService=makeService();await branchedService.openSession(id);
      const branched=await branchedService.getSession();
      assert.equal(branched.model.provider,PROFILE_PREFIX+a.id);
      for(const [profile,api] of [[c,"anthropic-messages"],[d,"openai-responses"]]) {
        await branchedService.switchModelProfile(profile.id);
        assert.equal(branched.model.api,api);
        assert.ok((await branched.modelRuntime.getAuth(branched.model)).auth.apiKey === input.apiKey);
      }
      // legacy注入的密钥不能污染后续SDK凭据配置。
      const record=JSON.parse(await readFile(path.join(base,"settings.json"),"utf8"));
      record.profiles[0].authMode="saved";
      record.profiles[0].encryptedKey=Buffer.from("legacy-placeholder").toString("base64");
      await writeFile(path.join(base,"settings.json"),JSON.stringify(record));
      await branchedService.switchModelProfile("legacy");
      assert.ok((await branched.modelRuntime.getAuth(branched.model)).auth.apiKey === "legacy-placeholder");
      await branchedService.switchModelProfile(sdk.id);
      assert.ok((await branched.modelRuntime.getAuth(branched.model)).auth.apiKey === "sdk-placeholder");
      await branchedService.switchModelProfile("legacy");
      branched.dispose();
      const legacyService=makeService();await legacyService.openSession(id);
      const legacy=await legacyService.getSession();assert.equal(legacy.model.provider,"deepseek");legacy.dispose();
      // 配置丢失必须拒绝，不写坏历史也不回退到默认项。
      const manager=legacy.sessionManager;
      manager.appendModelChange(PROFILE_PREFIX+"missing",input.modelId);
      const before=await readFile(file,"utf8");
      await assert.rejects(makeService().openSession(id),/配置不存在/);
      assert.equal(await readFile(file,"utf8"),before);
    }
    check().catch(error=>{console.error(error);process.exitCode=1;});
  `;
  const result = await runFile(process.execPath, ["-e", script, base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "pi-config"), PI_OFFLINE: "1", DEEPSEEK_API_KEY: "sdk-placeholder", AGENT_WORKSPACE_DIR: workspace },
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  assert.equal(result.stdout, "");
});
