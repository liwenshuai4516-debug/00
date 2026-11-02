export function createCatalogEnrichmentPanel(root, api, getModel, applyResult) {
  const start = root.querySelector("[data-enrich]");
  const cancel = root.querySelector("[data-cancel-enrich]");
  const status = root.querySelector("[data-enrich-status]");
  const results = root.querySelector("[data-enrich-results]");
  let busy = true, current, version = 0;
  function update() {
    start.disabled = busy || current?.status === "running";
    cancel.hidden = current?.status !== "running";
    cancel.disabled = busy;
    for (const button of results.querySelectorAll("button")) button.disabled = busy;
  }
  function render(job) {
    if (current?.id === job.id && current.revision > job.revision) return;
    current = job;
    status.textContent = job.message || job.progress || "正在准备……";
    results.replaceChildren();
    for (const item of job.results ?? []) {
      const row = document.createElement("div"); row.className = "enrichment-result";
      const description = document.createElement("p");
      description.textContent = item.status === "matched"
        ? `${item.id} · ${item.source} / ${item.matchedId}${item.alias ? "（别名匹配）" : ""}\n上下文：${item.contextWindow ?? "未知"}，输出上限：${item.maxTokens ?? "未知"}`
        : `${item.id} · ${item.message}${item.suggestions?.length ? " " + item.suggestions.join("、") : ""}`;
      row.append(description);
      if (item.status === "matched") {
        const apply = document.createElement("button"); apply.type = "button"; apply.textContent = "补充到编辑表单";
        apply.addEventListener("click", () => {
          if (busy) return;
          if (getModel() !== item.id) { status.textContent = "请先在编辑表单选择此模型，再应用参数。"; return; }
          applyResult(item); status.textContent = "已补充表单中的空白参数，请核对后保存。";
        });
        row.append(apply);
      }
      results.append(row);
    }
    update();
  }
  start.addEventListener("click", async () => {
    if (start.disabled) return;
    const ids = root.querySelector("#enrichment-ids").value.split(/\n/).map(id => id.trim()).filter(Boolean);
    if (!ids.length && getModel()) ids.push(getModel());
    const hint = root.querySelector("#enrichment-hint").value.trim();
    version++;
    start.disabled = true;
    try { render(await api.enrichModels(ids, ids.length === 1 && hint ? { [ids[0]]: hint } : {})); }
    catch (error) { status.textContent = error.message; update(); }
  });
  cancel.addEventListener("click", () => {
    if (!cancel.disabled && current) void api.cancelModelEnrichment(current.id).catch(error => { status.textContent = error.message; });
  });
  return { setBusy(value) { busy = value; update(); },
    async load() { const token = ++version; const jobs = await api.listModelEnrichments?.(); if (token === version && jobs?.length) render(jobs.at(-1)); },
    close() { version++; },
    onEvent(event) { if (event.type === "enrichment") render(event.value); },
  };
}
