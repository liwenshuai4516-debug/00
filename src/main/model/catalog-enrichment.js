const { randomUUID } = require("node:crypto");
const normalize = value => value.trim().toLowerCase().replace(/_/g, "-").split("/").at(-1);
const stripAlias = value => normalize(value).replace(/(?:-(?:thinking|high|low|max|preview|latest|exp|\d{4,8})){1,3}$/, "");
const positive = value => Number.isSafeInteger(value) && value > 0 ? value : undefined;

function parseCatalog(body, source) {
  const models = [];
  if (source === "OpenRouter") {
    if (!Array.isArray(body?.data)) throw new Error("参考目录格式无效。");
    for (const item of body.data) {
      if (typeof item?.id !== "string") continue;
      models.push({ id: item.id, contextWindow: positive(item.top_provider?.context_length ?? item.context_length),
        maxTokens: positive(item.top_provider?.max_completion_tokens),
        vision: Array.isArray(item.architecture?.input_modalities) ? item.architecture.input_modalities.includes("image") : undefined,
        reasoning: Array.isArray(item.supported_parameters) ? item.supported_parameters.some(name => ["reasoning", "include_reasoning"].includes(name)) : undefined, source });
    }
  } else {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("参考目录格式无效。");
    for (const provider of Object.values(body)) for (const [id, item] of Object.entries(provider?.models ?? {})) {
      models.push({ id: typeof item.id === "string" ? item.id : id, contextWindow: positive(item.limit?.context),
        maxTokens: positive(item.limit?.output), vision: Array.isArray(item.modalities?.input) ? item.modalities.input.includes("image") : undefined,
        reasoning: typeof item.reasoning === "boolean" ? item.reasoning : undefined, source });
    }
  }
  return models;
}

function matchModel(id, catalog, hint = "") {
  const query = hint || id;
  const exact = catalog.filter(item => item.id.toLowerCase() === query.toLowerCase());
  let matches = exact.length ? exact : catalog.filter(item => normalize(item.id) === normalize(query));
  let alias = false;
  if (!matches.length) { matches = catalog.filter(item => normalize(item.id) === stripAlias(query)); alias = true; }
  if (!matches.length) return { id, status: "unmatched", message: "参考目录中未找到该模型。" };
  const first = matches[0];
  if (matches.some(item => ["contextWindow", "maxTokens", "reasoning", "vision"].some(name => item[name] !== first[name]))) {
    return { id, status: "ambiguous", message: "存在多个不同参数的模型，请填写完整目录编号。", suggestions: matches.map(item => item.id) };
  }
  return { ...first, id, status: "matched", matchedId: first.id, alias };
}

function createCatalogEnrichment(fetchImpl = fetch) {
  const jobs = new Map();
  const listeners = new Set();
  const cache = new Map();
  const view = job => ({ id: job.id, revision: job.revision ?? 0, status: job.status, progress: job.progress, results: job.results, message: job.message });
  const emit = job => { job.revision = (job.revision ?? 0) + 1; for (const listener of listeners) listener(view(job)); };
  async function catalog(source, signal) {
    const hit = cache.get(source);
    if (hit && Date.now() - hit.time < 86400000) return hit.models;
    const response = await fetchImpl(source === "OpenRouter" ? "https://openrouter.ai/api/v1/models" : "https://models.dev/api.json", {
      signal: AbortSignal.any([signal, AbortSignal.timeout(30000)]), redirect: "error",
    });
    if (!response.ok) throw new Error("参考目录读取失败。");
    const body = await response.json();
    signal.throwIfAborted();
    const models = parseCatalog(body, source);
    cache.set(source, { time: Date.now(), models });
    return models;
  }
  async function run(job, ids, hints) {
    try {
      job.progress = "正在读取 OpenRouter 公开目录……"; emit(job);
      let primary = [], secondary = [];
      try { primary = await catalog("OpenRouter", job.controller.signal); } catch (error) { if (job.controller.signal.aborted) throw error; }
      if (!primary.length || ids.some(id => {
        const match = matchModel(id, primary, hints[id]);
        return match.status !== "matched" || ["contextWindow", "maxTokens", "reasoning", "vision"].some(name => match[name] === undefined);
      })) {
        job.progress = "正在读取 models.dev 公开目录……"; emit(job);
        try { secondary = await catalog("models.dev", job.controller.signal); } catch (error) { if (job.controller.signal.aborted) throw error; }
      }
      if (!primary.length && !secondary.length) throw new Error("参考目录不可用，请检查网络后重试。");
      job.controller.signal.throwIfAborted();
      job.results = ids.map(id => {
        const first = matchModel(id, primary, hints[id]);
        if (first.status === "ambiguous") return first;
        const second = matchModel(id, secondary, hints[id]);
        if (first.status !== "matched") return second;
        if (second.status === "matched") {
          const filled = ["contextWindow", "maxTokens", "reasoning", "vision"].filter(name => first[name] === undefined && second[name] !== undefined);
          for (const name of filled) first[name] = second[name];
          if (filled.length) first.source += ` + models.dev (${second.matchedId})`;
        }
        return first;
      });
      job.status = "success"; job.progress = "参数匹配完成，请核对来源后应用。";
    } catch {
      job.status = job.controller.signal.aborted ? "cancelled" : "failed";
      job.message = job.status === "cancelled" ? "参数补全已取消。" : "参考目录不可用，请稍后重试。";
    } finally { emit(job); }
  }
  function start(ids, hints = {}) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || ids.some(id => typeof id !== "string" || !id.trim() || id.length > 300)) throw new Error("请选择 1 至 100 个有效模型。");
    if (!hints || typeof hints !== "object" || Array.isArray(hints) || Object.values(hints).some(value => typeof value !== "string" || value.length > 300)) throw new Error("参考模型编号无效。");
    if ([...jobs.values()].some(job => job.status === "running")) throw new Error("请先等待或取消正在进行的参数补全。");
    // 完成项只保留最近一次，避免页面反复操作后无限累积。
    jobs.clear();
    const job = { id: randomUUID(), status: "running", results: [], controller: new AbortController() };
    jobs.set(job.id, job); void run(job, [...new Set(ids)], hints ?? {});
    return view(job);
  }
  return { start, list: () => [...jobs.values()].map(view), cancel: id => jobs.get(id)?.controller.abort(),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { for (const job of jobs.values()) job.controller.abort(); listeners.clear(); },
  };
}

module.exports = { createCatalogEnrichment, parseCatalog, matchModel };
