// 会话内容搜索：只读最近若干会话的展示文本，命中后返回片段。
// 不做全文索引或模糊匹配，扫描量与结果数都有上限，避免阻塞聊天。
const MIN_QUERY = 2;
const MAX_QUERY = 64;
const MAX_SESSIONS = 8;
const MAX_ITEMS = 12;
const SNIPPET_RADIUS = 30;

function snippetAround(text, index, length) {
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(text.length, index + length + SNIPPET_RADIUS);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function createSessionSearch({
  listSessions,
  previewSession,
  maxSessions = MAX_SESSIONS,
  maxItems = MAX_ITEMS,
}) {
  return async function searchSessions(query) {
    const needle = typeof query === "string" ? query.trim().toLowerCase() : "";
    if (needle.length < MIN_QUERY) return { items: [], truncated: false };
    if (needle.length > MAX_QUERY) throw new Error("搜索词过长。");

    const sessions = (await listSessions())
      .filter((session) => typeof session?.id === "string")
      .sort((first, second) => (second.updatedAt ?? 0) - (first.updatedAt ?? 0));

    const items = [];
    for (const session of sessions.slice(0, maxSessions)) {
      if (items.length >= maxItems) break;
      let preview;
      try {
        preview = await previewSession(session.id);
      } catch {
        continue;
      }
      const history = Array.isArray(preview?.history) ? preview.history : [];
      let snippet = "";
      let matches = 0;
      for (const message of history) {
        const text = typeof message?.text === "string" ? message.text : "";
        if (text === "") continue;
        const lower = text.toLowerCase();
        let index = lower.indexOf(needle);
        while (index !== -1) {
          matches += 1;
          if (snippet === "") snippet = snippetAround(text, index, needle.length);
          index = lower.indexOf(needle, index + needle.length);
          if (matches >= 99) break;
        }
      }
      if (matches > 0) items.push({ id: session.id, matches, snippet });
    }

    return { items, truncated: sessions.length > maxSessions || items.length >= maxItems };
  };
}

module.exports = { createSessionSearch };
