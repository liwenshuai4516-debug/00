import { ModelRuntime, readStoredCredential } from "@mariozechner/pi-coding-agent";

export async function createCredentialRuntime(credentialsStore, options = {}) {
  const fallback = await ModelRuntime.create();
  const fallbackList = await fallback.listCredentials();
  const aliases = new Map();
  const source = id => aliases.get(id) ?? id;
  const credentials = {
    async read(id) {
      const provider = source(id);
      const state = await credentialsStore.state(provider);
      return state.overridden ? state.credential : readStoredCredential(provider);
    },
    async list() {
      const local = await credentialsStore.list();
      const overridden = new Set(local.map(item => item.providerId));
      const entries = new Map(fallbackList.filter(item => !overridden.has(item.providerId)).map(item => [item.providerId, item.type]));
      for (const item of local) if (item.mode !== "none") entries.set(item.providerId, item.mode);
      for (const [id, provider] of aliases) if (entries.has(provider)) entries.set(id, entries.get(provider));
      return [...entries].map(([providerId, type]) => ({ providerId, type }));
    },
    modify(id, fn, options) {
      return credentialsStore.modify(source(id), async current => fn(current ?? await credentials.read(id)), options);
    },
    delete(id) { return credentialsStore.logout(source(id)); },
  };
  const runtime = await ModelRuntime.create({ ...options, credentials });
  // 命名空间配置的 OAuth 刷新与多密钥始终回到原供应商，加密记录只有一份。
  runtime.desktopCredentialAliases = aliases;
  return runtime;
}
