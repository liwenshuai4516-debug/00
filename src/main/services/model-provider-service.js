const { mkdir, readFile, rename, writeFile } = require("node:fs/promises");
const path = require("node:path");

// models.json 可选的接口协议与思考级别，页面下拉直接复用这份清单。
const API_OPTIONS = [
  "openai-completions",
  "openai-responses",
  "anthropic-messages",
  "google-generative-ai",
  "mistral-conversations",
  "azure-openai-responses",
  "openai-codex-responses",
  "bedrock-converse-stream",
  "google-vertex",
  "pi-messages",
];
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const INPUT_MODALITIES = ["text", "image"];
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];
// 表单用 JSON 文本编辑的字段，与 models.json 同名；不逐项校验内部结构。
const JSON_FIELDS = ["inputLimits", "samplingParams", "samplingParamsByThinkingLevel", "promptCache"];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function readText(value, label, { required = false, max = 200 } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (required && !text) throw new Error(`${label}不能为空。`);
  if (text.length > max) throw new Error(`${label}不能超过 ${max} 个字符。`);
  return text;
}

function readInteger(value, label, { min = 1 } = {}) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < min) {
    throw new Error(`${label}需要是不小于 ${min} 的整数。`);
  }
  return number;
}

function readRate(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) throw new Error(`${label}需要是不小于 0 的数字。`);
  return number;
}

function createModelProviderService(
  openFile,
  readAgentDir = async () => (await import("@mariozechner/pi-coding-agent")).getAgentDir(),
) {
  async function configurationPath() {
    return path.join(await readAgentDir(), "models.json");
  }

  async function readConfiguration() {
    return { modelsPath: await configurationPath() };
  }

  // 只解析官方配置文件本身；不读取认证信息，也不改写其他内容。
  async function readDocument() {
    const file = await configurationPath();
    let raw;
    try {
      raw = await readFile(file, "utf8");
    } catch (error) {
      if (error.code === "ENOENT") return { file, document: { providers: {} } };
      throw new Error(`无法读取 models.json：${error.message}`);
    }

    let document;
    try {
      document = JSON.parse(raw);
    } catch {
      throw new Error("models.json 不是有效的 JSON，请先用文本编辑器修正后再使用表单。");
    }
    if (!isPlainObject(document)) throw new Error("models.json 顶层需要是对象。");
    if (document.providers === undefined) document.providers = {};
    if (!isPlainObject(document.providers)) throw new Error("models.json 的 providers 需要是对象。");
    return { file, document };
  }

  async function writeDocument(file, document) {
    await mkdir(path.dirname(file), { recursive: true });
    // 先写临时文件再替换，避免中途失败留下半份配置；权限保持仅本人可读写。
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, file);
  }

  // 页面编辑只认识这些字段；headers 与 apiKey 属于凭据，不回传也不覆盖。
  function publicModel(model) {
    const source = isPlainObject(model) ? model : {};
    const extra = {};
    for (const field of JSON_FIELDS) {
      if (isPlainObject(source[field])) extra[field] = source[field];
    }
    return {
      id: typeof source.id === "string" ? source.id : "",
      name: typeof source.name === "string" ? source.name : "",
      api: typeof source.api === "string" ? source.api : "",
      baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
      reasoning: source.reasoning === true,
      contextWindow: typeof source.contextWindow === "number" ? source.contextWindow : undefined,
      maxTokens: typeof source.maxTokens === "number" ? source.maxTokens : undefined,
      input: Array.isArray(source.input) ? source.input.filter((item) => INPUT_MODALITIES.includes(item)) : undefined,
      cost: isPlainObject(source.cost)
        ? COST_FIELDS.reduce((result, field) => {
            if (typeof source.cost[field] === "number") result[field] = source.cost[field];
            return result;
          }, {})
        : undefined,
      thinkingLevelMap: isPlainObject(source.thinkingLevelMap) ? source.thinkingLevelMap : undefined,
      thinkingFormat: isPlainObject(source.compat) ? source.compat.thinkingFormat : undefined,
      extra: Object.keys(extra).length ? extra : undefined,
    };
  }

  function credentialOf(source) {
    const key = typeof source?.apiKey === "string" ? source.apiKey.trim() : "";
    if (!key) {
      return {
        hasApiKey: false,
        credential: "unknown",
        credentialDetail: "models.json 未配置 apiKey；环境变量或 auth.json 仍可能提供认证",
      };
    }
    if (key.startsWith("$")) {
      const name = key.slice(1);
      const resolved = name.length > 0 && typeof process.env[name] === "string" && process.env[name] !== "";
      return {
        hasApiKey: true,
        credential: resolved ? "environment" : "environment-missing",
        credentialDetail: resolved ? `使用环境变量 ${name}` : `环境变量 ${name} 未设置`,
      };
    }
    return { hasApiKey: true, credential: "configured", credentialDetail: "models.json 已配置 apiKey" };
  }

  async function readCatalog() {
    const { file, document } = await readDocument();
    const providers = Object.entries(document.providers).map(([id, block]) => {
      const source = isPlainObject(block) ? block : {};
      const models = Array.isArray(source.models) ? source.models : [];
      return {
        id,
        name: typeof source.name === "string" ? source.name : "",
        baseUrl: typeof source.baseUrl === "string" ? source.baseUrl : "",
        api: typeof source.api === "string" ? source.api : "",
        // 只说明认证来源与是否可用，不回传密钥或请求头内容。
        ...credentialOf(source),
        models: models.map(publicModel),
      };
    });
    return {
      modelsPath: file,
      providers,
      options: { api: API_OPTIONS, thinkingLevels: THINKING_LEVELS, inputs: INPUT_MODALITIES },
    };
  }

  // 把表单字段合并到已有模型对象上，未涉及字段（headers 等）保持原样。
  function mergeModel(base, input) {
    const model = { ...base };
    const id = readText(input?.id, "模型编号", { required: true, max: 200 });
    if (/\s/.test(id)) throw new Error("模型编号不能包含空格。");

    model.id = id;
    const name = readText(input?.name, "显示名称", { max: 200 });
    const api = readText(input?.api, "接口协议", { max: 60 });
    if (api && !API_OPTIONS.includes(api)) {
      throw new Error(`接口协议只能是：${API_OPTIONS.join("、")}。`);
    }
    const baseUrl = readText(input?.baseUrl, "模型 Base URL", { max: 500 });
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) throw new Error("模型 Base URL 需要以 http:// 或 https:// 开头。");

    for (const [field, value] of [["name", name], ["api", api], ["baseUrl", baseUrl]]) {
      if (value) model[field] = value;
      else delete model[field];
    }

    if (input?.reasoning === true) model.reasoning = true;
    else delete model.reasoning;

    const contextWindow = readInteger(input?.contextWindow, "上下文窗口");
    const maxTokens = readInteger(input?.maxTokens, "最大输出");
    for (const [field, value] of [["contextWindow", contextWindow], ["maxTokens", maxTokens]]) {
      if (value === undefined) delete model[field];
      else model[field] = value;
    }

    const inputs = Array.isArray(input?.input)
      ? input.input.filter((item) => INPUT_MODALITIES.includes(item))
      : [];
    if (!inputs.length) throw new Error("至少需要选择一种输入类型。");
    model.input = inputs;

    const cost = COST_FIELDS.reduce((result, field) => {
      const value = readRate(input?.cost?.[field], `计费 ${field}`);
      if (value !== undefined) result[field] = value;
      return result;
    }, {});
    if (Object.keys(cost).length) model.cost = { ...(isPlainObject(base.cost) ? base.cost : {}), ...cost };
    else delete model.cost;

    if (model.reasoning) {
      const enabled = Array.isArray(input?.thinkingLevels) ? input.thinkingLevels : [];
      // 显式写出每个级别：null 表示该模型没有这一档，SDK 据此收窄可选值。
      model.thinkingLevelMap = THINKING_LEVELS.reduce((map, level) => {
        map[level] = enabled.includes(level) ? level : null;
        return map;
      }, {});
    } else {
      delete model.thinkingLevelMap;
    }

    // 兼容性只改思考协议一项，其余 compat 标记沿用原配置。
    const compat = isPlainObject(base.compat) ? { ...base.compat } : {};
    const thinkingFormat = readText(input?.thinkingFormat, "思考协议", { max: 40 });
    if (thinkingFormat) compat.thinkingFormat = thinkingFormat;
    else delete compat.thinkingFormat;
    if (Object.keys(compat).length) model.compat = compat;
    else delete model.compat;

    const extra = isPlainObject(input?.extra) ? input.extra : {};
    for (const field of JSON_FIELDS) {
      const value = extra[field];
      if (value === undefined) continue;
      if (!isPlainObject(value)) throw new Error(`${field} 需要是 JSON 对象。`);
      if (Object.keys(value).length) model[field] = value;
      else delete model[field];
    }

    return model;
  }

  async function saveModel(input) {
    const { file, document } = await readDocument();
    const providerId = readText(input?.providerId, "供应商编号", { required: true, max: 64 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
      throw new Error("供应商编号只能包含字母、数字、点、下划线和短横线，并以字母或数字开头。");
    }

    const providerName = readText(input?.provider?.name, "供应商名称", { max: 100 });
    const providerBaseUrl = readText(input?.provider?.baseUrl, "供应商 Base URL", { max: 500 });
    if (providerBaseUrl && !/^https?:\/\//i.test(providerBaseUrl)) {
      throw new Error("供应商 Base URL 需要以 http:// 或 https:// 开头。");
    }
    const providerApi = readText(input?.provider?.api, "供应商接口协议", { max: 60 });
    if (providerApi && !API_OPTIONS.includes(providerApi)) {
      throw new Error(`供应商接口协议只能是：${API_OPTIONS.join("、")}。`);
    }

    // 编辑时以原模型对象为底稿，保留表单不涉及的字段。
    const originalProvider = input?.original?.providerId;
    const originalModelId = input?.original?.modelId;
    const editing = typeof originalProvider === "string" && typeof originalModelId === "string";
    let base = {};
    let insertIndex;
    if (editing) {
      const originalBlock = document.providers[originalProvider];
      const originalModels = isPlainObject(originalBlock) && Array.isArray(originalBlock.models) ? originalBlock.models : [];
      const index = originalModels.findIndex((item) => isPlainObject(item) && item.id === originalModelId);
      if (index < 0) throw new Error("要修改的模型已经不存在，请重新读取后再试。");
      base = originalModels[index];
      originalModels.splice(index, 1);
      // 同一供应商内修改时保持原有顺序，不把条目挪到末尾。
      if (originalProvider === providerId) insertIndex = index;
      // 换到其他供应商时清理已经空掉的旧区块。
      if (originalProvider !== providerId && !originalModels.length && isPlainObject(originalBlock) && !originalBlock.modelOverrides) {
        delete document.providers[originalProvider];
      }
    }

    const provider = { ...(isPlainObject(document.providers[providerId]) ? document.providers[providerId] : {}) };
    for (const [field, value] of [["name", providerName], ["baseUrl", providerBaseUrl], ["api", providerApi]]) {
      if (value) provider[field] = value;
      else delete provider[field];
    }
    const models = Array.isArray(provider.models) ? [...provider.models] : [];

    const model = mergeModel(base, input?.model);
    // 除自身之外出现同编号模型时拒绝保存，避免两个条目争用同一个模型。
    if (models.some((item) => isPlainObject(item) && item.id === model.id)) {
      throw new Error(`供应商 ${providerId} 下已存在编号为 ${model.id} 的模型。`);
    }
    if (insertIndex !== undefined && insertIndex <= models.length) models.splice(insertIndex, 0, model);
    else models.push(model);
    provider.models = models;
    document.providers[providerId] = provider;

    await writeDocument(file, document);
    return {
      modelsPath: file,
      providerId,
      modelId: model.id,
      action: editing ? "updated" : "created",
    };
  }

  async function deleteModel(providerId, modelId) {
    const { file, document } = await readDocument();
    const block = document.providers[providerId];
    const models = isPlainObject(block) && Array.isArray(block.models) ? block.models : [];
    const index = models.findIndex((item) => isPlainObject(item) && item.id === modelId);
    if (index < 0) throw new Error("该模型不在 models.json 中，可能已被其他程序移除。");

    models.splice(index, 1);
    // 没有模型且没有针对模型的覆盖配置时，整个供应商区块一并移除。
    if (!models.length && !block?.modelOverrides) delete document.providers[providerId];
    else block.models = models;

    await writeDocument(file, document);
    return { modelsPath: file, providerId, modelId, action: "deleted" };
  }

  // 提供商层编辑只动 name/baseUrl/api，保留 models、apiKey、headers 等未展示内容。
  async function saveProvider(input) {
    const { file, document } = await readDocument();
    const providerId = readText(input?.providerId, "供应商编号", { required: true, max: 64 });
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(providerId)) {
      throw new Error("供应商编号只能包含字母、数字、点、下划线和短横线，并以字母或数字开头。");
    }

    const name = readText(input?.provider?.name, "供应商名称", { max: 100 });
    const baseUrl = readText(input?.provider?.baseUrl, "供应商 Base URL", { max: 500 });
    if (baseUrl && !/^https?:\/\//i.test(baseUrl)) {
      throw new Error("供应商 Base URL 需要以 http:// 或 https:// 开头。");
    }
    const api = readText(input?.provider?.api, "供应商接口协议", { max: 60 });
    if (api && !API_OPTIONS.includes(api)) {
      throw new Error(`供应商接口协议只能是：${API_OPTIONS.join("、")}。`);
    }

    const existing = document.providers[providerId];
    const provider = { ...(isPlainObject(existing) ? existing : {}) };
    for (const [field, value] of [["name", name], ["baseUrl", baseUrl], ["api", api]]) {
      if (value) provider[field] = value;
      else delete provider[field];
    }

    if (typeof input?.apiKey === "string") {
      const key = input.apiKey.trim();
      if (key.length > 500 || /[\r\n\0]/.test(key)) {
        throw new Error("API 密钥不能包含换行或空字符，且不能超过 500 个字符。");
      }
      if (key) provider.apiKey = key;
      else if (input.clearApiKey === true) delete provider.apiKey;
    } else if (input?.clearApiKey === true) {
      delete provider.apiKey;
    }

    if (Array.isArray(input?.models)) {
      const previous = new Map(
        (Array.isArray(existing?.models) ? existing.models : [])
          .filter((model) => isPlainObject(model) && typeof model.id === "string")
          .map((model) => [model.id, model]),
      );
      const seen = new Set();
      provider.models = input.models.map((source) => {
        const id = readText(source?.id, "模型编号", { required: true, max: 200 });
        if (seen.has(id)) throw new Error(`模型编号重复：${id}。`);
        seen.add(id);
        return mergeModel(previous.get(id) ?? {}, source);
      });
    } else if (!Array.isArray(provider.models)) {
      provider.models = [];
    }
    document.providers[providerId] = provider;

    await writeDocument(file, document);
    return {
      modelsPath: file,
      providerId,
      action: isPlainObject(existing) ? "updated" : "created",
    };
  }

  // 删除整个提供商区块（含模型与覆盖配置）；当前/默认模型是否仍可用由运行时重读判断。
  async function deleteProvider(providerId) {
    const { file, document } = await readDocument();
    const id = readText(providerId, "供应商编号", { required: true, max: 64 });
    const block = document.providers[id];
    if (!isPlainObject(block)) {
      throw new Error("该供应商不在 models.json 中，可能已被其他程序移除。");
    }
    const modelCount = Array.isArray(block.models) ? block.models.length : 0;
    delete document.providers[id];

    await writeDocument(file, document);
    return { modelsPath: file, providerId: id, modelCount, action: "deleted" };
  }

  // 模型发现只支持当前桌面已接入的三类协议；密钥只在主进程中用于本次请求，不回传。
  async function discoverModels(input) {
    const baseUrl = readText(input?.baseUrl, "供应商 Base URL", { required: true, max: 500 });
    if (!/^https?:\/\//i.test(baseUrl)) throw new Error("供应商 Base URL 需要以 http:// 或 https:// 开头。");
    const api = readText(input?.api, "供应商接口协议", { required: true, max: 60 });
    if (!["openai-completions", "openai-responses", "anthropic-messages"].includes(api)) {
      throw new Error("当前协议不支持自动发现模型，请手动填写模型编号。");
    }

    let key = readText(input?.apiKey, "API 密钥", { max: 500 });
    if (!key && typeof input?.providerId === "string" && input.providerId.trim()) {
      const { document } = await readDocument();
      const block = document.providers[input.providerId.trim()];
      key = typeof block?.apiKey === "string" ? block.apiKey.trim() : "";
    }
    if (key.startsWith("$")) key = process.env[key.slice(1)] ?? "";

    let base;
    try {
      base = new URL(baseUrl);
    } catch {
      throw new Error("供应商 Base URL 无效。");
    }
    if (base.username || base.password) throw new Error("供应商地址不能包含账号或密码。");
    const path = base.pathname.replace(/\/+$/, "");
    const suffix = api === "anthropic-messages"
      ? (path.endsWith("/v1") ? "/models" : "/v1/models")
      : "/models";
    base.pathname = `${path}${suffix}` || "/models";

    const headers = { accept: "application/json" };
    if (api === "anthropic-messages") {
      if (key) headers["x-api-key"] = key;
      headers["anthropic-version"] = "2023-06-01";
    } else if (key) {
      headers.authorization = `Bearer ${key}`;
    }

    let response;
    try {
      response = await fetch(base, { headers, signal: AbortSignal.timeout(15000) });
    } catch (error) {
      throw new Error(`无法连接模型目录：${error.message}`);
    }
    if (!response.ok) throw new Error(`模型目录请求失败：HTTP ${response.status}。`);
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new Error("模型目录返回的不是有效 JSON。");
    }
    const list = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models) ? payload.models : [];
    if (!Array.isArray(list)) throw new Error("模型目录格式无效。");
    const seen = new Set();
    const models = [];
    for (const item of list) {
      const id = readText(item?.id, "模型编号", { max: 200 });
      if (!id || seen.has(id)) continue;
      seen.add(id);
      models.push({ id, name: readText(item?.name ?? item?.display_name, "显示名称", { max: 200 }) });
      if (models.length >= 200) break;
    }
    return { models };
  }

  async function openConfiguration() {
    const { modelsPath } = await readConfiguration();
    await mkdir(path.dirname(modelsPath), { recursive: true });
    try {
      // 仅首次创建空配置；已有文件和凭据不读取、不覆盖、不回填页面。
      await writeFile(modelsPath, '{\n  "providers": {}\n}\n', { flag: "wx", mode: 0o600 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const error = await openFile(modelsPath);
    if (error) throw new Error("无法打开 models.json，请使用文本编辑器打开所示路径。");
  }

  return { readConfiguration, readCatalog, saveModel, deleteModel, saveProvider, deleteProvider, discoverModels, openConfiguration };
}

module.exports = { createModelProviderService };
