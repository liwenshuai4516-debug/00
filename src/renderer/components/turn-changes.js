// 轮末改动卡片：只展示主进程记录的本轮文件与行数，点击进入右侧栏审阅。
const MAX_ROWS = 6;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function statText(file) {
  if (file.binary) return "二进制";
  if (file.oversized) return "过大";
  return `+${file.added} −${file.deleted}`;
}

function totalsOf(files) {
  let added = 0;
  let deleted = 0;
  for (const file of files) {
    if (file.binary || file.oversized) continue;
    added += Number(file.added) || 0;
    deleted += Number(file.deleted) || 0;
  }
  return { added, deleted };
}

function openReview(requestId, index) {
  document.dispatchEvent(new CustomEvent("open-changes-review", {
    detail: { requestId, index },
  }));
}

/**
 * @param {{requestId:string,files:Array<{index:number,display:string,added:number,deleted:number,binary:boolean,oversized:boolean}>,total:number,truncated:boolean}} summary
 * @returns {HTMLElement|null} 没有改动时不生成卡片
 */
export function createTurnChangesCard(summary) {
  if (!summary || !Array.isArray(summary.files) || summary.files.length === 0) return null;
  const requestId = summary.requestId;
  if (typeof requestId !== "string" || requestId === "") return null;

  const total = Number.isInteger(summary.total) ? summary.total : summary.files.length;
  const totals = totalsOf(summary.files);

  const card = element("section", "turn-changes");
  card.setAttribute("aria-label", "本轮改动");

  const header = element("header", "turn-changes__header");
  header.append(element("span", "turn-changes__title", "本轮改动"));
  const meta = [`${total} 个文件`];
  if (totals.added > 0 || totals.deleted > 0) {
    meta.push(`+${totals.added} −${totals.deleted}`);
  }
  header.append(element("span", "turn-changes__meta", meta.join(" · ")));
  card.append(header);

  const list = element("ul", "turn-changes__files");
  for (const file of summary.files.slice(0, MAX_ROWS)) {
    const item = element("li");
    const button = element("button", "turn-changes__file");
    button.type = "button";
    button.dataset.index = String(file.index);
    button.title = `在右侧栏查看 ${file.display} 的差异`;
    button.append(element("span", "turn-changes__path", file.display));
    button.append(element("span", "turn-changes__stat", statText(file)));
    button.addEventListener("click", () => openReview(requestId, file.index));
    item.append(button);
    list.append(item);
  }
  card.append(list);

  if (summary.files.length > MAX_ROWS) {
    const more = element("button", "turn-changes__more", `查看全部 ${summary.files.length} 个文件`);
    more.type = "button";
    more.addEventListener("click", () => openReview(requestId, -1));
    card.append(more);
  }

  return card;
}
