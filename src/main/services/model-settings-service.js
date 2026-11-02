const { normalizeProfile, PROFILE_PREFIX } = require("../storage/model-settings-store.js");
const { fetchModelCatalog, fetchModelEntries } = require("../model/catalog-fetch.js");
const { createOAuthFlowManager } = require("../model/oauth-flow.js");
const { createCatalogEnrichment } = require("../model/catalog-enrichment.js");

async function createSettingsCatalog(modelsStore) {
  const { ModelRuntime } = await import("@mariozechner/pi-coding-agent");
  return ModelRuntime.create({
    modelsStore, modelsPath: null, refreshOnCreate: true, allowModelNetwork: false,
    credentials: {
      async read() {}, async list() { return []; },
      async modify() { throw new Error("目录只读。"); },
      async delete() { throw new Error("目录只读。"); },
    },
  });
}

function createModelSettingsService(store, createCatalog = createSettingsCatalog, options = {}) {
  let catalogPromise;
  let authRuntimePromise;
  async function createRuntime() {
    if (options.createRuntime) return options.createRuntime();
    if (options.credentialsStore) {
      const { createCredentialRuntime } = await import("../model/credential-runtime.mjs");
      return createCredentialRuntime(options.credentialsStore, { modelsStore: options.catalogStore });
    }
    const { ModelRuntime } = await import("@mariozechner/pi-coding-agent");
    return ModelRuntime.create({ modelsStore: options.catalogStore });
  }
  function getAuthRuntime() {
    if (!authRuntimePromise) authRuntimePromise = createRuntime().catch(error => { authRuntimePromise = undefined; throw error; });
    return authRuntimePromise;
  }
  const oauth = createOAuthFlowManager(getAuthRuntime);
  const enrichment = createCatalogEnrichment(options.fetch);
  function getCatalog() {
    if (!catalogPromise) {
      catalogPromise = Promise.resolve().then(() => createCatalog(options.catalogStore)).catch((error) => {
        catalogPromise = undefined;
        throw error;
      });
    }
    return catalogPromise;
  }

  async function read() {
    const [settings, catalog] = await Promise.all([store.read(), getCatalog()]);
    let environment = null;
    let environmentError = "";
    try {
      environment = store.readEnvironment();
    } catch (error) {
      environmentError = error.message;
    }
    return {
      ...settings, environment, environmentError, encryptionAvailable: store.canEncrypt(),
      providers: catalog.getProviders().filter((item) => (item.auth?.apiKey || item.auth?.oauth) && catalog.getModels(item.id).length)
        .map((item) => ({ id: item.id, name: item.name, supportsApiKey: Boolean(item.auth.apiKey), supportsOAuth: Boolean(item.auth.oauth) })),
    };
  }

  async function listModels(provider) {
    const catalog = await getCatalog();
    if (!catalog.getProvider(provider) || !catalog.getModels(provider).length) {
      throw new Error("请选择内置供应商，或使用自定义兼容接口。");
    }
    const extra = await store.readCatalog?.(`builtin:${provider}`) ?? [];
    const models = new Map(catalog.getModels(provider).map((item) => [item.id, { id: item.id, name: item.name }]));
    for (const model of extra) if (!models.has(model.id)) models.set(model.id, model);
    return [...models.values()];
  }

  async function save(input) {
    const config = normalizeProfile(input);
    let model;
    if (config.kind === "builtin") {
      const catalog = await getCatalog();
      const provider = catalog.getProvider(config.provider);
      if (config.authMode === "oauth" ? !provider?.auth?.oauth : !provider?.auth?.apiKey) {
        throw new Error("供应商不支持所选认证方式。");
      }
      const source = catalog.getModel(config.provider, config.modelId) ??
        (await store.readCatalog?.(`builtin:${config.provider}`))?.find(item => item.id === config.modelId);
      if (!source) throw new Error("供应商未登记该聊天模型；自定义模型请选择自定义供应商。");
      if (!source.api || !source.contextWindow || !source.maxTokens) throw new Error("模型参数不完整，请补充模型参数。");
      model = {
        id: source.id, name: source.name, api: source.api,
        baseUrl: config.baseUrl || source.baseUrl || provider.baseUrl || catalog.getModels(config.provider)[0]?.baseUrl,
        input: source.input ?? (source.vision ? ["text", "image"] : ["text"]), inputLimits: source.inputLimits,
        headers: source.headers,
        reasoning: source.reasoning ?? false, contextWindow: source.contextWindow,
        maxTokens: source.maxTokens, cost: source.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, compat: source.compat,
        thinkingLevelMap: source.thinkingLevelMap, promptCache: source.promptCache,
        samplingParams: source.samplingParams, samplingParamsByThinkingLevel: source.samplingParamsByThinkingLevel,
      };
    } else {
      model = {
        id: config.modelId, name: config.modelId, api: config.api, baseUrl: config.baseUrl,
        input: config.vision ? ["text", "image"] : ["text"], reasoning: config.reasoning,
        contextWindow: config.contextWindow, maxTokens: config.maxTokens,
        // SDK 必需字段；自定义价格未知，不用于页面费用展示。
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }
    return store.add({ ...config, apiKey: input.apiKey }, model, input.replaceId);
  }

  async function clone(id, name) {
    const original = await store.loadProfile(id);
    if (!original.model) return save({ ...original, name });
    return store.add({ ...original, name }, original.model);
  }

  async function requestInput(input) {
    const result = { baseUrl: input?.baseUrl, apiKey: input?.apiKey, api: input?.api };
    if (input?.profileId && !result.apiKey) {
      const profile = await store.loadProfile(input.profileId);
      // 已保存密钥只用于其原地址，改变地址后需要显式重新输入。
      if (result.baseUrl !== profile.baseUrl && result.baseUrl !== profile.model?.baseUrl) throw new Error("地址已改变，请重新输入 API 密钥后探测。");
      result.apiKey = profile.apiKey;
      if (!result.apiKey && profile.authMode === "provider") {
        const state = await options.credentialsStore?.state(profile.provider);
        if (state?.credential?.type === "api_key") result.apiKey = state.credential.key;
      }
      if (!result.apiKey) {
        const runtime = await getAuthRuntime();
        const model = runtime.getModel(profile.provider, profile.modelId);
        const auth = model ? await runtime.getAuth(model) : undefined;
        result.apiKey = auth?.auth.apiKey;
      }
    }
    if (!result.apiKey && input?.provider) {
      const state = await options.credentialsStore?.state(input.provider);
      if (state?.credential?.type === "api_key") result.apiKey = state.credential.key;
    }
    return result;
  }
  async function fetchCatalog(input) {
    return fetchModelCatalog(await requestInput(input), options.fetch);
  }
  async function testConnection(input) {
    const start = Date.now();
    const models = await fetchCatalog(input);
    return { latencyMs: Date.now() - start, count: models.length };
  }
  async function refreshProfile(id) {
    const profile = await store.loadProfile(id);
    if (profile.kind === "builtin") {
      const models = await refreshBuiltin(profile.provider);
      return { total: models.length, models };
    }
    const input = await requestInput({ profileId: id, baseUrl: profile.baseUrl || profile.model?.baseUrl, api: profile.model?.api });
    const models = await fetchModelEntries(input, options.fetch);
    const merged = await store.mergeCatalog(`profile:${id}`, models);
    return { total: merged.length, models: merged };
  }
  async function refreshBuiltin(provider) {
    const catalog = await getCatalog();
    if (!catalog.getProvider(provider)) throw new Error("供应商不存在。");
    const runtime = await getAuthRuntime();
    await runtime.refresh({ allowNetwork: false });
    if (!runtime.hasConfiguredAuth(provider)) throw new Error("请先配置该供应商的密钥或登录，再刷新官方目录。");
    const result = await runtime.refresh({ allowNetwork: true, force: true, providers: [provider], signal: AbortSignal.timeout(30000) });
    if (result.aborted || result.errors.size) throw new Error("官方目录刷新未完成，请检查网络后重试。");
    await catalog.refresh({ allowNetwork: false, providers: [provider] });
    return listModels(provider);
  }
  async function appendBuiltin(provider, input) {
    const catalog = await getCatalog();
    const native = catalog.getProvider(provider);
    if (!native) throw new Error("供应商不存在。");
    const config = normalizeProfile({ ...input, kind: "custom", provider, name: input.modelId, baseUrl: native.baseUrl || catalog.getModels(provider)[0]?.baseUrl, authMode: "saved" });
    if (catalog.getModel(provider, config.modelId) || (await store.readCatalog(`builtin:${provider}`)).some(item => item.id === config.modelId)) throw new Error("模型编号已存在。");
    return store.mergeCatalog(`builtin:${provider}`, [{ id: config.modelId, name: config.name, api: config.api,
      contextWindow: config.contextWindow, maxTokens: config.maxTokens, reasoning: config.reasoning, vision: config.vision }]);
  }
  function credentialsStore() {
    if (!options.credentialsStore) throw new Error("当前环境未启用供应商凭据管理。");
    return options.credentialsStore;
  }
  async function providerAuth(provider) {
    const runtime = await getAuthRuntime();
    await runtime.refresh({ allowNetwork: false });
    const keys = await credentialsStore().listKeys(provider);
    const state = await credentialsStore().state(provider);
    return { ...keys, configured: state.overridden ? Boolean(state.credential) : runtime.hasConfiguredAuth(provider),
      oauth: state.overridden ? state.credential?.type === "oauth" : runtime.isUsingOAuth(provider) };
  }
  async function logout(provider) {
    for (const flow of oauth.list()) if (flow.provider === provider && flow.status === "running") oauth.cancel(flow.id);
    await (await getAuthRuntime()).logout(provider);
  }
  async function openOAuthLink(id) {
    const flow = oauth.list().find(item => item.id === id && item.status === "running");
    const raw = flow?.event?.url ?? flow?.event?.links?.[0]?.url;
    if (!URL.canParse(raw)) throw new Error("当前登录没有可打开的链接。");
    const url = new URL(raw);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || !options.openExternal) throw new Error("登录链接不可打开。");
    await options.openExternal(url.toString());
  }

  async function listForSession(session) {
    const provider = session.model?.provider ?? "";
    const includeId = provider.startsWith(PROFILE_PREFIX) ? provider.slice(PROFILE_PREFIX.length) : "legacy";
    const data = await store.read(includeId);
    const currentProfileId = provider.startsWith(PROFILE_PREFIX)
      ? provider.slice(PROFILE_PREFIX.length)
      : data.profiles.some((item) => item.id === "legacy" && item.provider === provider) ? "legacy" : "";
    return { ...data, currentProfileId, currentModelId: session.model?.id ?? "" };
  }

  async function describeCurrent(session) {
    const data = await listForSession(session);
    const selected = data.profiles.find((item) => item.id === data.currentProfileId);
    if (!selected) throw new Error("当前会话的模型配置已缺失。");
    return { provider: selected.provider, modelId: session.model.id, profileName: selected.name };
  }

  async function switchProfile(session, id) {
    if (typeof id !== "string" || !id) throw new Error("请选择模型配置。");
    const profile = await store.loadProfile(id);
    const { installModelProfile } = await import("../model-profile-runtime.mjs");
    const model = await installModelProfile(session.modelRuntime, profile);
    if (session.model?.provider !== model.provider || session.model.id !== model.id) {
      // SDK 追加当前会话的模型选择，不改写全局默认或重建会话。
      await session.setModel(model, { persist: false });
    }
    return describeCurrent(session);
  }

  return {
    read, listModels, save, listForSession, describeCurrent, switchProfile, clone, createRuntime,
    fetchCatalog, testConnection, refreshProfile, refreshBuiltin, appendBuiltin, providerAuth, oauth, logout, openOAuthLink, enrichment,
    addKey: (provider, name, key) => credentialsStore().addKey(provider, name, key),
    activateKey: (provider, id) => credentialsStore().activateKey(provider, id),
    removeKey: (provider, id) => credentialsStore().removeKey(provider, id),
    setDefault: store.setDefault, clearDefault: store.clearDefault, hide: store.hide, resolveSelection: store.resolveSelection,
  };
}

module.exports = { createModelSettingsService, createSettingsCatalog };
