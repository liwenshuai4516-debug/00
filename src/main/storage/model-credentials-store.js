const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { readFile, mkdir, writeFile, rename, rm } = require("node:fs/promises");

// API 密钥与 OAuth 令牌共用加密存储；写入和令牌刷新按文件串行。
function createModelCredentialsStore(file, safeStorage) {
  let pending = Promise.resolve();
  const canEncrypt = () => safeStorage.isEncryptionAvailable();
  function serialize(action) {
    const operation = pending.then(action);
    pending = operation.catch(() => {});
    return operation;
  }
  function encrypt(value) {
    if (!canEncrypt()) throw new Error("系统密钥保护不可用。");
    try { return safeStorage.encryptString(JSON.stringify(value)).toString("base64"); }
    catch { throw new Error("凭据加密失败，原记录未修改。"); }
  }
  function decrypt(value) {
    if (!canEncrypt()) throw new Error("系统密钥保护不可用。");
    try { return JSON.parse(safeStorage.decryptString(Buffer.from(value, "base64"))); }
    catch { throw new Error("无法解密凭据，请检查本机密钥保护环境。"); }
  }
  async function load() {
    let raw;
    try { raw = await readFile(file, "utf8"); }
    catch (error) { if (error.code === "ENOENT") return { version: 1, providers: {} }; throw error; }
    try {
      const record = JSON.parse(raw);
      if (record.version !== 1 || !record.providers || typeof record.providers !== "object" || Array.isArray(record.providers)) throw new Error();
      for (const entry of Object.values(record.providers)) {
        if (!Array.isArray(entry.keys) || !["none", "api_key", "oauth"].includes(entry.mode) ||
          entry.keys.some(key => typeof key.id !== "string" || typeof key.name !== "string" || typeof key.encrypted !== "string") ||
          new Set(entry.keys.map(key => key.id)).size !== entry.keys.length ||
          (entry.activeKeyId && !entry.keys.some(key => key.id === entry.activeKeyId)) ||
          (entry.mode === "api_key" && !entry.activeKeyId) ||
          (entry.mode === "oauth" && typeof entry.oauth !== "string")) throw new Error();
      }
      return record;
    } catch { throw new Error("模型凭据文件损坏，原文件未覆盖。"); }
  }
  async function publish(record) {
    await mkdir(path.dirname(file), { recursive: true });
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, JSON.stringify(record) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, file);
    } finally { await rm(temporary, { force: true }).catch(() => {}); }
  }
  function providerId(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 200 || ["__proto__", "constructor", "prototype"].includes(value)) throw new Error("供应商编号无效。");
    return value;
  }
  function entryFor(record, id) {
    providerId(id);
    if (!Object.hasOwn(record.providers, id)) record.providers[id] = { keys: [], activeKeyId: "", mode: "none" };
    return record.providers[id];
  }
  function credential(entry) {
    if (entry?.mode === "oauth") return decrypt(entry.oauth);
    if (entry?.mode === "api_key") return { type: "api_key", key: decrypt(entry.keys.find(key => key.id === entry.activeKeyId).encrypted) };
  }
  async function state(id) {
    providerId(id);
    const record = await load();
    const entry = Object.hasOwn(record.providers, id) ? record.providers[id] : undefined;
    return { overridden: Boolean(entry), credential: credential(entry) };
  }
  async function listKeys(id) {
    providerId(id);
    const record = await load();
    const entry = Object.hasOwn(record.providers, id) ? record.providers[id] : undefined;
    return { mode: entry?.mode ?? "none", activeKeyId: entry?.activeKeyId ?? "", keys: (entry?.keys ?? []).map(({ id, name }) => ({ id, name })) };
  }
  function addKey(id, name, key) {
    return serialize(async () => {
      if (typeof name !== "string" || !name.trim() || name.trim().length > 80) throw new Error("请输入密钥名称（最多 80 字）。");
      if (typeof key !== "string" || !key.trim() || key.length > 8192 || /[\r\n\0]/.test(key)) throw new Error("请输入有效的 API 密钥。");
      const record = await load();
      const entry = entryFor(record, id);
      if (entry.keys.some(item => item.name === name.trim())) throw new Error("密钥名称已存在。");
      const item = { id: randomUUID(), name: name.trim(), encrypted: encrypt(key.trim()) };
      entry.keys.push(item);
      if (!entry.activeKeyId) { entry.activeKeyId = item.id; entry.mode = "api_key"; }
      await publish(record);
      return { id: item.id, name: item.name };
    });
  }
  function changeKey(id, keyId, remove) {
    return serialize(async () => {
      const record = await load();
      const entry = entryFor(record, id);
      if (!entry.keys.some(item => item.id === keyId)) throw new Error("密钥不存在。");
      if (remove) {
        entry.keys = entry.keys.filter(item => item.id !== keyId);
        if (entry.activeKeyId === keyId) { entry.activeKeyId = ""; if (entry.mode === "api_key") entry.mode = "none"; }
      } else { entry.activeKeyId = keyId; entry.mode = "api_key"; }
      await publish(record);
    });
  }
  function modify(id, fn, options = {}) {
    return serialize(async () => {
      options.signal?.throwIfAborted();
      const record = await load();
      const entry = entryFor(record, id);
      const result = await fn(credential(entry));
      options.signal?.throwIfAborted();
      if (result !== undefined) {
        if (result.type !== "oauth") throw new Error("此入口只保存 OAuth 凭据。");
        entry.oauth = encrypt(result); entry.mode = "oauth";
        await publish(record);
      }
      return result ?? credential(entry);
    });
  }
  function logout(id) {
    return serialize(async () => {
      const record = await load();
      const entry = entryFor(record, id);
      delete entry.oauth; entry.mode = "none";
      await publish(record);
    });
  }
  async function list() {
    const record = await load();
    return Object.entries(record.providers).map(([providerId, entry]) => ({ providerId, mode: entry.mode }));
  }
  return { canEncrypt, state, listKeys, addKey, activateKey: (id, key) => changeKey(id, key, false), removeKey: (id, key) => changeKey(id, key, true), modify, logout, list };
}

module.exports = { createModelCredentialsStore };
