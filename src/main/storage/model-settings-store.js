const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readFile, mkdir, writeFile, rename, rm } = require("node:fs/promises");

const PROFILE_PREFIX = "desktop-profile-";
const CUSTOM_APIS = ["openai-completions", "openai-responses", "anthropic-messages"];

function text(value, label) {
  if (typeof value !== "string") throw new Error(`${label}必须是文本。`);
  return value.trim();
}

function normalizeProfile(input) {
  if (!input || !["builtin", "custom"].includes(input.kind)) {
    throw new Error("请选择内置或自定义供应商。");
  }
  const profile = {
    name: text(input.name, "配置名称"),
    kind: input.kind,
    provider: text(input.provider, "供应商"),
    modelId: text(input.modelId, "模型 ID"),
    baseUrl: text(input.baseUrl, "API 地址"),
    authMode: input.authMode,
  };
  if (!profile.name || profile.name.length > 80 || !profile.provider || !profile.modelId) {
    throw new Error("请填写配置名称、供应商和模型 ID。");
  }
  if (!["sdk", "saved"].includes(profile.authMode)) throw new Error("请选择凭据来源。");
  if (profile.baseUrl) {
    const url = URL.canParse(profile.baseUrl) ? new URL(profile.baseUrl) : null;
    if (!url || !["http:", "https:"].includes(url.protocol) ||
      url.username || url.password || url.search || url.hash) {
      throw new Error("API 地址须为不含账号、查询参数或片段的完整 HTTP/HTTPS 地址。");
    }
  }
  if (profile.kind === "custom") {
    if (!profile.baseUrl || profile.authMode !== "saved" || !CUSTOM_APIS.includes(input.api)) {
      throw new Error("自定义供应商需要地址、API 密钥和支持的接口协议。");
    }
    if (!Number.isSafeInteger(input.contextWindow) || !Number.isSafeInteger(input.maxTokens) ||
      input.contextWindow < 1 || input.maxTokens < 1 || input.maxTokens > input.contextWindow) {
      throw new Error("请填写真实的上下文窗口和最大输出 tokens，输出不能大于窗口。");
    }
    Object.assign(profile, {
      api: input.api, contextWindow: input.contextWindow, maxTokens: input.maxTokens,
    });
  }
  return profile;
}

// 配置采用新增方式保存，编号和内容固定，历史会话不会被后续另存覆盖。
function createModelSettingsStore(settingsPath, safeStorage, env = process.env) {
  const defaults = {
    provider: (env.PI_PROVIDER ?? "").trim(),
    modelId: (env.PI_MODEL ?? "").trim(),
    baseUrl: (env.PI_BASE_URL ?? "").trim(),
  };
  const canEncrypt = () => safeStorage.isEncryptionAvailable();

  function legacy(config) {
    return {
      id: "legacy", name: "原有模型配置", kind: "builtin",
      provider: config.provider, modelId: config.modelId, baseUrl: config.baseUrl ?? "",
      authMode: config.authMode ?? "sdk", encryptedKey: config.encryptedKey ?? "",
    };
  }

  function validateRecord(record) {
    if (record?.version !== 2 || !Array.isArray(record.profiles)) throw new Error();
    const ids = new Set();
    for (const profile of record.profiles) {
      normalizeProfile(profile);
      if (typeof profile.id !== "string" || !/^(legacy|[0-9a-f-]{36})$/.test(profile.id) || ids.has(profile.id)) {
        throw new Error();
      }
      ids.add(profile.id);
      if (typeof profile.encryptedKey !== "string" ||
        (profile.authMode === "saved") !== Boolean(profile.encryptedKey)) throw new Error();
      if (profile.id !== "legacy") {
        const model = profile.model;
        if (!model || model.id !== profile.modelId || typeof model.api !== "string" ||
          !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 ||
          !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || model.maxTokens > model.contextWindow ||
          typeof model.baseUrl !== "string" || !model.baseUrl) throw new Error();
      }
    }
    if (record.profiles.length ? !ids.has(record.defaultProfileId) : record.defaultProfileId !== "") {
      throw new Error();
    }
    return record;
  }

  async function readRecord() {
    let content;
    try {
      content = await readFile(settingsPath, "utf8");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      // 没有配置文件时，仅保留已有的有效启动选择，不为页面捏造默认模型。
      const profiles = defaults.provider && defaults.modelId ? [legacy(defaults)] : [];
      return { version: 2, defaultProfileId: profiles.length ? "legacy" : "", profiles };
    }
    try {
      let record = JSON.parse(content);
      // 旧版只在下一次成功写入时升级，密文原样保留，不读取密钥原文。
      if (record.version === 1) {
        record = { version: 2, defaultProfileId: "legacy", profiles: [legacy(record)] };
      }
      return validateRecord(record);
    } catch {
      throw new Error("模型配置文件损坏，未回退或覆盖原文件。");
    }
  }

  function publicProfile(profile) {
    const { id, name, kind, provider, modelId, baseUrl, authMode } = profile;
    return {
      id, name, kind, provider, modelId, baseUrl, authMode,
      hasSavedKey: Boolean(profile.encryptedKey),
      api: profile.model?.api ?? profile.api ?? "",
    };
  }

  async function read() {
    const record = await readRecord();
    return { defaultProfileId: record.defaultProfileId, profiles: record.profiles.map(publicProfile) };
  }

  function readEnvironment() {
    if (!defaults.provider || !defaults.modelId) return null;
    // 只返回非敏感字段；运行时自行读取 loadEnvFile 已载入的供应商凭据。
    const { provider, modelId, baseUrl } = normalizeProfile(legacy(defaults));
    return { provider, modelId, baseUrl };
  }

  async function publish(record) {
    validateRecord(record);
    await mkdir(path.dirname(settingsPath), { recursive: true });
    const temporaryPath = `${settingsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporaryPath, JSON.stringify(record) + "\n", {
        encoding: "utf8", mode: 0o600, flag: "wx",
      });
      await rename(temporaryPath, settingsPath);
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => {});
    }
  }

  async function add(input, model) {
    const normalized = normalizeProfile(input);
    const record = await readRecord();
    if (record.profiles.some((profile) => profile.name === normalized.name)) {
      throw new Error("配置名称已存在，请换一个名称另存。");
    }
    let encryptedKey = "";
    if (normalized.authMode === "saved") {
      const key = text(input.apiKey, "API 密钥");
      if (!key || key.length > 8192 || /[\r\n\0]/.test(key)) throw new Error("请输入有效的 API 密钥。");
      if (!canEncrypt()) throw new Error("系统密钥保护不可用，不能保存 API 密钥。");
      try {
        encryptedKey = safeStorage.encryptString(key).toString("base64");
      } catch {
        throw new Error("密钥加密失败，原配置未修改。");
      }
    }
    const profile = { ...normalized, id: randomUUID(), model, encryptedKey };
    record.profiles.push(profile);
    if (!record.defaultProfileId) record.defaultProfileId = profile.id;
    await publish(record);
    return publicProfile(profile);
  }

  async function setDefault(id) {
    const record = await readRecord();
    if (!record.profiles.some((profile) => profile.id === id)) throw new Error("模型配置不存在。");
    record.defaultProfileId = id;
    await publish(record);
    return id;
  }

  async function loadProfile(id) {
    const record = await readRecord();
    const profile = record.profiles.find((item) => item.id === id);
    if (!profile) throw new Error("会话绑定的模型配置不存在，请恢复原配置文件。");
    const result = { ...profile, ...normalizeProfile(profile) };
    delete result.encryptedKey;
    if (profile.authMode === "saved") {
      if (!canEncrypt()) throw new Error("系统密钥保护暂不可用。");
      try {
        result.apiKey = safeStorage.decryptString(Buffer.from(profile.encryptedKey, "base64"));
        if (!result.apiKey) throw new Error();
      } catch {
        throw new Error("无法解密所选配置的密钥，请恢复本机密钥保护环境。");
      }
    }
    return result;
  }

  async function resolveSelection(saved) {
    const record = await readRecord();
    if (!saved) return loadProfile(record.defaultProfileId);
    if (saved.provider.startsWith(PROFILE_PREFIX)) {
      const profile = await loadProfile(saved.provider.slice(PROFILE_PREFIX.length));
      if (profile.modelId !== saved.modelId) throw new Error("会话模型与已保存配置不一致。");
      return profile;
    }
    // 原生供应商记录只能使用原有配置，不能认领到同名的新供应商。
    const original = record.profiles.find((profile) => profile.id === "legacy");
    if (!original || original.provider !== saved.provider) {
      throw new Error("旧会话属于其他供应商，请恢复原有配置；未套用新配置。");
    }
    return { ...await loadProfile("legacy"), modelId: saved.modelId };
  }

  return { read, readEnvironment, add, setDefault, loadProfile, resolveSelection, canEncrypt };
}

module.exports = { createModelSettingsStore, normalizeProfile, PROFILE_PREFIX, CUSTOM_APIS };
