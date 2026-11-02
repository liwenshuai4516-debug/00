export function createCatalogTools(root, api, setPageBusy, onChanged) {
  const provider = root.querySelector("[data-catalog-provider]");
  const form = root.querySelector("form");
  const status = root.querySelector("[data-catalog-status]");
  let busy = true;
  function setBusy(value) {
    busy = value;
    for (const element of root.querySelectorAll("button, input, select")) element.disabled = value || !provider.value;
  }
  async function run(action, message) {
    if (busy || !provider.value) return;
    setPageBusy(true); status.textContent = "正在更新模型目录……";
    try { await action(); await onChanged(provider.value); status.textContent = message; }
    catch (error) { status.textContent = `目录更新未完成：${error.message}`; }
    finally { setPageBusy(false); }
  }
  root.querySelector("[data-refresh-builtin]").addEventListener("click", () => {
    void run(() => api.refreshBuiltinModels(provider.value), "官方目录已刷新。");
  });
  form.addEventListener("submit", event => {
    event.preventDefault();
    const fields = form.elements;
    const input = { modelId: fields.modelId.value, api: fields.api.value, contextWindow: Number(fields.contextWindow.value),
      maxTokens: Number(fields.maxTokens.value), reasoning: fields.reasoning.checked, vision: fields.vision.checked };
    void run(() => api.appendBuiltinModel(provider.value, input), "模型已补充到内置目录，可在新增配置中选择。");
  });
  return { setBusy, load(data) {
    const previous = provider.value; provider.replaceChildren();
    for (const item of data.providers ?? []) {
      const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; provider.append(option);
    }
    if ([...provider.options].some(item => item.value === previous)) provider.value = previous;
    setBusy(busy);
  } };
}
