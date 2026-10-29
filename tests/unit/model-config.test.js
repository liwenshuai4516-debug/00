const { test } = require("node:test");
const assert = require("node:assert/strict");
const {
  readModelConfig,
} = require("../../src/main/config/model-config.js");

test("清理模型配置两端的普通空格和不换行空格", () => {
  assert.deepEqual(
    readModelConfig({
      PI_PROVIDER: " deepseek ",
      PI_MODEL: "\u00a0deepseek-flash\u00a0",
      PI_BASE_URL: " https://api.deepseek.com\u00a0",
    }),
    {
      provider: "deepseek",
      modelId: "deepseek-flash",
      baseUrl: "https://api.deepseek.com",
    },
  );
});

test("缺少或只有空白的供应商、模型返回明确错误", () => {
  const cases = [
    {},
    { PI_MODEL: "model" },
    { PI_PROVIDER: "provider" },
    { PI_PROVIDER: " ", PI_MODEL: "model" },
    { PI_PROVIDER: "provider", PI_MODEL: "\u00a0" },
  ];

  for (const env of cases) {
    assert.throws(() => readModelConfig(env), {
      message: "请在 .env 中配置 PI_PROVIDER 和 PI_MODEL。",
    });
  }
});

test("未配置地址或地址只有空白时继续使用 SDK 默认地址", () => {
  for (const extra of [{}, { PI_BASE_URL: " \u00a0 " }]) {
    const config = readModelConfig({
      PI_PROVIDER: "provider",
      PI_MODEL: "model",
      ...extra,
    });

    assert.equal(config.baseUrl, "");
  }
});

test("支持 HTTP 和 HTTPS，并保留地址路径及末尾斜杠", () => {
  const addresses = [
    "http://127.0.0.1:11434/v1",
    "https://example.com/custom/v1/",
  ];

  for (const baseUrl of addresses) {
    const config = readModelConfig({
      PI_PROVIDER: "provider",
      PI_MODEL: "model",
      PI_BASE_URL: baseUrl,
    });

    assert.equal(config.baseUrl, baseUrl);
  }
});

test("拒绝相对地址、缺少协议和非 HTTP 协议", () => {
  const addresses = [
    "/v1",
    "api.example.com",
    "https://",
    "ftp://example.com",
    "file:///tmp/model",
  ];

  for (const baseUrl of addresses) {
    assert.throws(
      () =>
        readModelConfig({
          PI_PROVIDER: "provider",
          PI_MODEL: "model",
          PI_BASE_URL: baseUrl,
        }),
      {
        message: "PI_BASE_URL 必须是完整的 http:// 或 https:// 地址。",
      },
    );
  }
});
