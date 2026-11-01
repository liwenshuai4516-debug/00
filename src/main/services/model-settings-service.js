const BUILTIN_PROVIDERS = ["openai", "anthropic", "deepseek"];

const { normalizeProfile, PROFILE_PREFIX } = require("../storage/model-settings-store.js");

async function createSettingsCatalog() {
  const { ModelRuntime } = await import("@mariozechner/pi-coding-agent");
  return ModelRuntime.create({
    modelsPath: null, refreshOnCreate: false, allowModelNetwork: false,
    credentials: {
      async read() {}, async list() { return []; },
      async modify() { throw new Error("目录只读。"); },
      async delete() { throw new Error("目录只读。"); },
    },
  });
}

function createModelSettingsService(store, createCatalog = createSettingsCatalog) {
  let catalogPromise;
  function getCatalog() {
    if (!catalogPromise) {
      catalogPromise = Promise.resolve().then(createCatalog).catch((error) => {
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
      providers: catalog.getProviders().filter((item) => BUILTIN_PROVIDERS.includes(item.id) && catalog.getModels(item.id).length)
        .map((item) => ({ id: item.id, name: item.name })),
    };
  }

  async function listModels(provider) {
    if (!BUILTIN_PROVIDERS.includes(provider)) throw new Error("请选择支持的内置供应商，或使用自定义兼容接口。");
    const catalog = await getCatalog();
    return catalog.getModels(provider).map((item) => ({ id: item.id, name: item.name }));
  }

  async function save(input) {
    const config = normalizeProfile(input);
    let model;
    if (config.kind === "builtin") {
      if (!BUILTIN_PROVIDERS.includes(config.provider)) {
        throw new Error("新增内置配置目前支持 OpenAI、Anthropic、DeepSeek；其他请选择自定义兼容接口。");
      }
      const catalog = await getCatalog();
      const source = catalog.getModel(config.provider, config.modelId);
      if (!source) throw new Error("供应商未登记该聊天模型；自定义模型请选择自定义供应商。");
      if (!catalog.getProvider(config.provider)?.auth.apiKey) {
        throw new Error("新增配置需要支持 API 密钥的供应商。");
      }
      model = {
        id: source.id, name: source.name, api: source.api,
        baseUrl: config.baseUrl || source.baseUrl, input: source.input, inputLimits: source.inputLimits,
        headers: source.headers,
        reasoning: source.reasoning, contextWindow: source.contextWindow,
        maxTokens: source.maxTokens, cost: source.cost, compat: source.compat,
        thinkingLevelMap: source.thinkingLevelMap, promptCache: source.promptCache,
        samplingParams: source.samplingParams, samplingParamsByThinkingLevel: source.samplingParamsByThinkingLevel,
      };
    } else {
      model = {
        id: config.modelId, name: config.modelId, api: config.api, baseUrl: config.baseUrl,
        input: ["text"], reasoning: false,
        contextWindow: config.contextWindow, maxTokens: config.maxTokens,
        // SDK 必需字段；自定义价格未知，不用于页面费用展示。
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      };
    }
    return store.add({ ...config, apiKey: input.apiKey }, model);
  }

  async function listForSession(session) {
    const data = await store.read();
    const provider = session.model?.provider ?? "";
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
    read, listModels, save, listForSession, describeCurrent, switchProfile,
    setDefault: store.setDefault, resolveSelection: store.resolveSelection,
  };
}

module.exports = { createModelSettingsService, createSettingsCatalog };
