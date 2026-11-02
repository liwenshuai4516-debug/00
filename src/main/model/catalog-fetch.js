async function fetchModelEntries(input, fetchImpl = fetch, callerSignal) {
  const url = URL.canParse(input?.baseUrl) ? new URL(input.baseUrl) : null;
  if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("请输入有效的 API 地址。");
  }
  if (typeof input.apiKey !== "string" || !input.apiKey.trim() || /[\r\n\0]/.test(input.apiKey)) {
    throw new Error("请输入有效的 API 密钥。");
  }
  if (!["openai-completions", "openai-responses", "anthropic-messages", "google-generative-ai"].includes(input.api)) {
    throw new Error("不支持的接口协议。");
  }
  const base = url.toString().replace(/\/+$/, "");
  const headers = input.api === "anthropic-messages"
    ? { "x-api-key": input.apiKey.trim(), "anthropic-version": "2023-06-01" }
    : input.api === "google-generative-ai" ? { "x-goog-api-key": input.apiKey.trim() }
    : { authorization: `Bearer ${input.apiKey.trim()}` };
  const signal = callerSignal ? AbortSignal.any([callerSignal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  let response;
  try {
    response = await fetchImpl(`${base}/models`, { headers, signal, redirect: "error" });
    if (response.status === 404 && !url.pathname.replace(/\/+$/, "").match(/\/v\d+[a-z-]*$/)) {
      response = await fetchImpl(`${base}/v1/models`, { headers, signal, redirect: "error" });
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const body = await response.json();
    const data = body?.data ?? body?.models?.map(item => ({ ...item, id: item.name?.replace(/^models\//, ""), name: item.displayName, context_window: item.inputTokenLimit, max_output_tokens: item.outputTokenLimit }));
    if (!Array.isArray(data)) throw new Error("响应格式不包含模型列表。");
    const entries = new Map();
    for (const item of data) {
      if (typeof item?.id !== "string" || !item.id.trim() || entries.has(item.id)) continue;
      const entry = { id: item.id, name: typeof item.name === "string" ? item.name : item.id };
      for (const [field, value] of [["contextWindow", item.context_window ?? item.context_length], ["maxTokens", item.max_output_tokens ?? item.max_tokens]]) {
        if (Number.isSafeInteger(value) && value > 0) entry[field] = value;
      }
      if (typeof item.reasoning === "boolean") entry.reasoning = item.reasoning;
      if (Array.isArray(item.input_modalities)) entry.vision = item.input_modalities.includes("image");
      entries.set(item.id, entry);
    }
    return [...entries.values()].sort((a, b) => a.id.localeCompare(b.id));
  } catch (error) {
    if (callerSignal?.aborted) throw new Error("操作已取消。");
    if (error.name === "TimeoutError") throw new Error("读取模型列表超时。");
    if (/^HTTP \d+$/.test(error.message) || error.message === "响应格式不包含模型列表。") throw error;
    throw new Error("无法读取模型列表，请检查地址和网络。");
  }
}

async function fetchModelCatalog(input, fetchImpl, signal) {
  return (await fetchModelEntries(input, fetchImpl, signal)).map(item => item.id);
}

module.exports = { fetchModelCatalog, fetchModelEntries };
