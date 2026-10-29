// 配置模块只读取、校验并返回数据，不加载 .env 或创建会话。
function readModelConfig(env = process.env) {
  // 同时清理普通空格和复制配置时可能带入的不换行空格。
  const provider = (env.PI_PROVIDER ?? "").trim();
  const modelId = (env.PI_MODEL ?? "").trim();
  const baseUrl = (env.PI_BASE_URL ?? "").trim();

  if (!provider || !modelId) {
    throw new Error("请在 .env 中配置 PI_PROVIDER 和 PI_MODEL。");
  }

  if (baseUrl) {
    const address = URL.canParse(baseUrl)
      ? new URL(baseUrl)
      : null;

    if (
      !address ||
      !["http:", "https:"].includes(address.protocol)
    ) {
      // 错误信息只指出字段，不回显配置原文。
      throw new Error(
        "PI_BASE_URL 必须是完整的 http:// 或 https:// 地址。",
      );
    }
  }

  // 保留用户配置的地址路径和末尾斜杠，避免改变供应商接口路径。
  return { provider, modelId, baseUrl };
}

module.exports = { readModelConfig };