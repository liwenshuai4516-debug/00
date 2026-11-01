import { ModelRuntime } from "@mariozechner/pi-coding-agent";
import storeModule from "./storage/model-settings-store.js";
const { PROFILE_PREFIX } = storeModule;

export async function installModelProfile(runtime, profile) {
  // 原有记录继续采用 SDK 原生 provider/modelId，兼容旧会话与分支。
  if (profile.id === "legacy") {
    if (profile.apiKey) await runtime.setRuntimeApiKey(profile.provider, profile.apiKey);
    if (profile.baseUrl) runtime.registerProvider(profile.provider, { baseUrl: profile.baseUrl });
    const model = runtime.getModel(profile.provider, profile.modelId);
    if (!model) throw new Error("原有配置的模型不在 SDK 目录中。");
    return model;
  }

  const providerId = `${PROFILE_PREFIX}${profile.id}`;
  const existing = runtime.getModel(providerId, profile.modelId);
  if (existing && runtime.hasConfiguredAuth(providerId)) return existing;
  let apiKey = profile.apiKey;
  let headers;
  if (profile.authMode === "sdk") {
    // 独立读取原生凭据，避免复用另一个配置已经注入的运行时密钥。
    const authRuntime = await ModelRuntime.create();
    const source = authRuntime.getModel(profile.provider, profile.modelId);
    if (!source) throw new Error("原生模型目录已变化，请另存新的模型配置。");
    // 新增配置只复用 API Key。OAuth 仍可通过原有配置使用，避免复制会过期的令牌。
    if (authRuntime.isUsingOAuth(profile.provider)) {
      throw new Error("新增配置请使用 API 密钥；OAuth 登录请继续使用原有配置。");
    }
    const auth = await authRuntime.getAuth(source);
    apiKey = auth?.auth.apiKey;
    headers = auth?.auth.headers;
  }
  if (!apiKey) throw new Error("所选配置没有可用的 API 密钥。");
  const model = profile.model;
  // 独立 provider 编号使同名模型的不同地址和密钥互不覆盖。
  runtime.registerProvider(providerId, {
    name: profile.name, api: model.api, baseUrl: model.baseUrl,
    headers, models: [model],
  });
  await runtime.setRuntimeApiKey(providerId, apiKey);
  const registered = runtime.getModel(providerId, profile.modelId);
  if (!registered) throw new Error("模型配置注册失败。");
  return registered;
}
