// DSH 风格的模型设置：提供商卡片 + 单个提供商编辑器。
// 数据仍写入 Pi 官方的 models.json；页面只接收脱敏目录，不读取已存密钥原文。

const LEVEL_LABELS = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
  max: "最大",
};
const DEFAULT_LEVELS = ["off", "minimal", "low", "medium", "high"];
const INPUT_LABELS = { text: "文本", image: "图片" };

function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(value % 1000 ? 1 : 0))}K`;
  return String(value);
}

function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "dataset") Object.assign(node.dataset, value);
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value === true ? "" : String(value));
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

function option(value, label) {
  return element("option", { value, text: label });
}

function chip(text, className) {
  return element("span", { class: className ? `model-chip ${className}` : "model-chip", text });
}

function levelsOf(model) {
  if (Array.isArray(model?.thinkingLevels) && model.thinkingLevels.length) return model.thinkingLevels;
  const map = model?.thinkingLevelMap;
  if (map && typeof map === "object") {
    const levels = Object.entries(map).filter(([, value]) => typeof value === "string").map(([level]) => level);
    if (levels.length) return levels;
  }
  return model?.reasoning ? DEFAULT_LEVELS : ["off"];
}

function modelDraft(source) {
  return {
    id: source?.id ?? "",
    name: source?.name ?? "",
    api: source?.api ?? "",
    baseUrl: source?.baseUrl ?? "",
    contextWindow: source?.contextWindow ?? "",
    maxTokens: source?.maxTokens ?? "",
    input: Array.isArray(source?.input) && source.input.length ? [...source.input] : ["text"],
    reasoning: source?.reasoning === true,
    thinkingLevels: levelsOf(source),
    cost: source?.cost,
    thinkingFormat: source?.thinkingFormat ?? "",
    extra: source?.extra,
  };
}

export function createModelProviders(panel, api, setPageBusy, refreshModels) {
  const list = panel.querySelector("[data-provider-list]");
  const addButton = panel.querySelector("[data-add-provider]");
  const editor = panel.querySelector("[data-provider-editor]");
  const stateBadge = panel.querySelector("[data-model-state]");
  const currentName = panel.querySelector("[data-current-model-name]");
  const defaultBadge = panel.querySelector("[data-default-model-label]");
  const warning = panel.querySelector("[data-models-warning]");
  const empty = panel.querySelector("[data-models-empty]");
  const status = panel.querySelector("[data-provider-status]");
  const pathNode = panel.querySelector("[data-models-path]");
  const copyButton = panel.querySelector("[data-copy-models-path]");
  const openButton = panel.querySelector("[data-open-models]");
  const reloadButton = panel.querySelector("[data-reload-models]");

  let busy = true;
  let loading = false;
  let sequence = 0;
  let modelsPath = "";
  let catalog = { providers: [], options: { api: [], thinkingLevels: [], inputs: [] } };
  let runtimeModels = [];
  let info = { provider: "", modelId: "", thinkingLevel: "off", thinkingLevels: [] };
  let defaults = { provider: "", modelId: "" };
  let editing = null;
  let pendingDeleteProvider = "";
  let candidates = null;

  function update() {
    const disabled = busy || loading;
    addButton.disabled = disabled;
    copyButton.disabled = disabled || !modelsPath;
    openButton.disabled = disabled;
    reloadButton.disabled = disabled;
    for (const button of panel.querySelectorAll(".model-provider-list button, .model-provider-editor button")) {
      button.disabled = disabled;
    }
  }

  function setBusy(value) {
    busy = value;
    update();
  }

  function showStatus(text, isError = false) {
    status.textContent = text;
    status.dataset.state = isError ? "error" : "";
  }

  function providerModels(provider) {
    const byId = new Map();
    for (const model of provider.models) byId.set(model.id, { ...model, available: false });
    for (const model of runtimeModels.filter((item) => item.provider === provider.id)) {
      byId.set(model.id, { ...(byId.get(model.id) ?? {}), ...model, available: true });
    }
    return [...byId.values()];
  }

  function providersView() {
    const result = catalog.providers.map((provider) => ({
      ...provider,
      models: providerModels(provider),
    }));
    const known = new Set(result.map((provider) => provider.id));
    for (const model of runtimeModels) {
      if (known.has(model.provider)) continue;
      known.add(model.provider);
      result.push({
        id: model.provider,
        name: model.provider,
        baseUrl: "",
        api: "",
        credential: "unknown",
        credentialDetail: "该提供商不在 models.json 中",
        models: runtimeModels.filter((item) => item.provider === model.provider),
      });
    }
    return result;
  }

  function currentModelName() {
    const model = runtimeModels.find((item) => item.provider === info.provider && item.id === info.modelId);
    return model?.name || info.modelId || "未选择模型";
  }

  function credentialState(provider) {
    if (provider?.credential === "configured" || provider?.credential === "environment") return "configured";
    if (provider?.credential === "environment-missing") return "missing";
    return "unknown";
  }

  function credentialHint(provider) {
    if (!provider) return "未在 models.json 配置 apiKey；环境变量或 auth.json 仍可能提供认证";
    return provider.credentialDetail || "未在 models.json 配置 apiKey";
  }

  function modelRow(provider, model) {
    const isCurrent = provider.id === info.provider && model.id === info.modelId;
    const isDefault = provider.id === defaults.provider && model.id === defaults.modelId;
    const row = element("div", { class: "model-row", dataset: { provider: provider.id, modelId: model.id } });
    if (isCurrent) row.classList.add("is-current");
    const body = element("div", { class: "model-row-body" },
      element("div", { class: "model-row-head" },
        element("span", { class: "model-row-name", text: model.name || model.id }),
        model.id && model.id !== model.name ? element("code", { class: "model-row-id", text: model.id }) : null,
        isCurrent ? chip("当前", "is-current") : null,
        isDefault ? chip("默认", "is-accent") : null,
        model.available === false ? chip("未加载", "is-muted") : null,
      ),
      element("div", { class: "model-row-meta" },
        formatTokens(model.contextWindow) ? chip(`上下文 ${formatTokens(model.contextWindow)}`) : null,
        formatTokens(model.maxTokens) ? chip(`输出 ${formatTokens(model.maxTokens)}`) : null,
        model.reasoning ? chip("推理", "is-accent") : null,
        (model.input ?? []).filter((value) => value === "image").length ? chip("图片") : null,
      ),
    );
    const actions = element("div", { class: "model-row-actions" });
    if (!isDefault) {
      const makeDefault = element("button", { type: "button", text: "设为默认", dataset: { action: "default" } });
      makeDefault.addEventListener("click", () => void setDefault(provider.id, model.id));
      actions.append(makeDefault);
    }
    row.append(body, actions);
    return row;
  }

  function providerCard(provider) {
    const card = element("section", { class: "model-catalog-group provider-card", dataset: { providerId: provider.id } });
    const dot = element("span", {
      class: "provider-credential-dot",
      dataset: { credential: credentialState(provider) },
      title: credentialHint(provider),
      "aria-label": credentialHint(provider),
    });
    const heading = element("h4", {},
      element("span", { class: "model-catalog-title", text: provider.name || provider.id }),
      element("code", { text: provider.id }),
      element("span", { class: "model-catalog-count", text: String(provider.models.length) }),
    );
    const actions = element("div", { class: "provider-card__actions" });
    const edit = element("button", { type: "button", text: "编辑", dataset: { providerAction: "edit" } });
    edit.addEventListener("click", () => openEditor(provider.id));
    const addModel = element("button", { type: "button", text: "新增模型", dataset: { providerAction: "add-model" } });
    addModel.addEventListener("click", () => openEditor(provider.id, true));
    actions.append(addModel, edit);
    card.append(element("div", { class: "provider-card__head" }, dot, heading, actions));

    if (provider.models.length) {
      const listNode = element("div", { class: "model-catalog-list" });
      for (const model of provider.models) listNode.append(modelRow(provider, model));
      card.append(listNode);
    } else {
      card.append(element("p", { class: "provider-empty", text: "该提供商暂无可运行模型；点击「新增模型」添加。" }));
    }
    return card;
  }

  function draw() {
    stateBadge.textContent = info.modelId ? "已就绪" : "未选择";
    stateBadge.dataset.state = info.modelId ? "ok" : "warn";
    currentName.textContent = currentModelName();
    defaultBadge.textContent = defaults.provider && defaults.modelId ? `默认 ${defaults.provider}/${defaults.modelId}` : "未设置默认";
    const providers = providersView();
    list.replaceChildren(...providers.map(providerCard));
    empty.hidden = providers.length > 0;
    empty.textContent = "当前 Pi 配置没有可用模型。用「添加模型提供商」创建第一个提供商。";
    pathNode.textContent = modelsPath || "models.json";
    copyButton.disabled = busy || loading || !modelsPath;
    openButton.disabled = busy || loading || !modelsPath;
    reloadButton.disabled = busy || loading || !modelsPath;
  }

  /* ------------------------------ 编辑器 ------------------------------ */

  function providerEditorDraft(providerId, addModel) {
    const provider = catalog.providers.find((item) => item.id === providerId);
    const listModels = provider
      ? provider.models.map(modelDraft)
      : runtimeModels.filter((item) => item.provider === providerId).map(modelDraft);
    if (addModel || listModels.length === 0) listModels.push(modelDraft({ input: ["text"] }));
    return {
      providerId: providerId ?? "",
      original: Boolean(provider),
      name: provider?.name ?? "",
      baseUrl: provider?.baseUrl ?? "",
      api: provider?.api ?? "",
      credential: provider?.credential ?? "unknown",
      credentialDetail: provider?.credentialDetail ?? "未在 models.json 配置 apiKey；环境变量或 auth.json 仍可能提供认证",
      apiKey: "",
      clearApiKey: false,
      models: listModels,
    };
  }

  function openEditor(providerId, addModel = false) {
    editing = providerEditorDraft(providerId ?? "", addModel);
    pendingDeleteProvider = "";
    candidates = null;
    renderEditor();
    editor.hidden = false;
    editor.scrollIntoView({ block: "nearest" });
  }

  function closeEditor() {
    editor.hidden = true;
    editor.replaceChildren();
    editing = null;
    candidates = null;
    pendingDeleteProvider = "";
  }

  function updateModelField(index, key, value) {
    if (!editing?.models[index]) return;
    editing.models[index][key] = value;
  }

  function modelEditorRow(model, index) {
    const row = element("div", { class: "model-editor-row", dataset: { index: String(index) } });
    const head = element("div", { class: "model-editor-row__head" },
      element("span", { class: "model-editor-row__title", text: `模型 ${index + 1}` }),
      element("button", {
        type: "button",
        class: "model-link-button",
        text: "移除",
        onclick: () => {
          editing.models.splice(index, 1);
          renderEditor();
        },
      }),
    );
    const grid = element("div", { class: "model-editor-grid" });
    const field = (label, input) => element("label", { class: "model-form-field" }, element("span", { text: label }), input);
    const id = element("input", { value: model.id, placeholder: "模型编号", spellcheck: "false", dataset: { modelField: "id" } });
    id.addEventListener("input", () => updateModelField(index, "id", id.value));
    const name = element("input", { value: model.name, placeholder: "显示名称（可选）", dataset: { modelField: "name" } });
    name.addEventListener("input", () => updateModelField(index, "name", name.value));
    const context = element("input", { type: "number", min: "1", step: "1", value: model.contextWindow, placeholder: "128000", dataset: { modelField: "contextWindow" } });
    context.addEventListener("input", () => updateModelField(index, "contextWindow", context.value));
    const max = element("input", { type: "number", min: "1", step: "1", value: model.maxTokens, placeholder: "16384", dataset: { modelField: "maxTokens" } });
    max.addEventListener("input", () => updateModelField(index, "maxTokens", max.value));
    grid.append(field("模型编号", id), field("显示名称", name), field("上下文窗口", context), field("最大输出", max));

    const inputs = element("div", { class: "model-check-row" });
    for (const value of ["text", "image"]) {
      const label = element("label", {});
      const checkbox = element("input", { type: "checkbox" });
      checkbox.checked = model.input.includes(value);
      checkbox.addEventListener("change", () => {
        const next = new Set(model.input);
        if (checkbox.checked) next.add(value);
        else next.delete(value);
        if (!next.size) {
          checkbox.checked = true;
          next.add("text");
        }
        model.input = [...next];
      });
      label.append(checkbox, element("span", { text: INPUT_LABELS[value] }));
      inputs.append(label);
    }
    grid.append(element("div", { class: "model-form-field" }, element("span", { text: "输入类型" }), inputs));

    const reasoning = element("input", { type: "checkbox" });
    reasoning.checked = model.reasoning;
    reasoning.addEventListener("change", () => {
      model.reasoning = reasoning.checked;
      if (!model.reasoning) model.thinkingLevels = ["off"];
      else if (!model.thinkingLevels || model.thinkingLevels.length <= 1) model.thinkingLevels = [...DEFAULT_LEVELS];
      renderEditor();
    });
    grid.append(element("label", { class: "model-switch" }, reasoning, element("span", { text: "支持思考强度" })));

    const levels = element("div", { class: "model-thinking-levels" });
    const allLevels = catalog.options.thinkingLevels?.length ? catalog.options.thinkingLevels : DEFAULT_LEVELS;
    for (const level of allLevels) {
      const label = element("label", { class: "model-level" });
      const checkbox = element("input", { type: "checkbox" });
      checkbox.checked = model.thinkingLevels.includes(level);
      checkbox.disabled = level === "off" || !model.reasoning;
      checkbox.addEventListener("change", () => {
        const next = new Set(model.thinkingLevels);
        if (checkbox.checked) next.add(level);
        else next.delete(level);
        if (!next.size) next.add("off");
        model.thinkingLevels = [...next];
      });
      label.append(checkbox, element("span", { text: LEVEL_LABELS[level] ?? level }));
      levels.append(label);
    }
    grid.append(element("div", { class: "model-form-field model-thinking-field" }, element("span", { text: "思考档位" }), levels));
    row.append(head, grid);
    return row;
  }

  function renderCandidates() {
    if (!candidates) return null;
    const box = element("div", { class: "model-candidates" });
    box.append(element("h4", { text: `可用模型（${candidates.length}）` }));
    const listNode = element("div", { class: "model-candidate-list" });
    for (const candidate of candidates) {
      const label = element("label", { class: "model-candidate" });
      const checkbox = element("input", { type: "checkbox" });
      checkbox.checked = candidate.checked;
      checkbox.addEventListener("change", () => { candidate.checked = checkbox.checked; });
      label.append(checkbox, element("code", { text: candidate.id }), candidate.name ? element("span", { text: candidate.name }) : null);
      listNode.append(label);
    }
    box.append(listNode, element("div", { class: "model-form-actions" },
      element("button", {
        type: "button",
        text: "添加所选",
        dataset: { addCandidates: "" },
        onclick: () => {
          const ids = new Set(editing.models.map((model) => model.id));
          for (const candidate of candidates) {
            if (!candidate.checked || ids.has(candidate.id)) continue;
            ids.add(candidate.id);
            editing.models.push(modelDraft({ id: candidate.id, name: candidate.name ?? "", input: ["text"] }));
          }
          candidates = null;
          renderEditor();
        },
      }),
      element("button", { type: "button", text: "取消", onclick: () => { candidates = null; renderEditor(); } }),
    ));
    return box;
  }

  function renderEditor() {
    if (!editing) return;
    const providerIdField = element("input", { value: editing.providerId, placeholder: "my-provider", spellcheck: "false", readonly: editing.original, dataset: { providerField: "providerId" } });
    providerIdField.addEventListener("input", () => { editing.providerId = providerIdField.value; });
    const nameField = element("input", { value: editing.name, placeholder: "显示名称（可选）", dataset: { providerField: "name" } });
    nameField.addEventListener("input", () => { editing.name = nameField.value; });
    const baseUrlField = element("input", { value: editing.baseUrl, placeholder: "https://api.example.com/v1", spellcheck: "false", dataset: { providerField: "baseUrl" } });
    baseUrlField.addEventListener("input", () => { editing.baseUrl = baseUrlField.value; });
    const apiField = element("select", { dataset: { providerField: "api" } });
    const apis = catalog.options.api?.length ? catalog.options.api : [];
    apiField.append(option("", "不设置，沿用内置默认"), ...apis.map((value) => option(value, value)));
    if (editing.api && !apis.includes(editing.api)) apiField.append(option(editing.api, editing.api));
    apiField.value = editing.api;
    apiField.addEventListener("change", () => { editing.api = apiField.value; });

    const keyInput = element("input", { type: "password", placeholder: editing.credential === "unknown" ? "输入 API 密钥；留空保持未配置" : "留空保持现有密钥", autocomplete: "new-password", dataset: { providerField: "apiKey" } });
    keyInput.addEventListener("input", () => { editing.apiKey = keyInput.value; });
    const keyToggle = element("button", { type: "button", class: "model-key-toggle", text: "显示", dataset: { keyToggle: "" } });
    keyToggle.addEventListener("click", () => {
      const shown = keyInput.type === "text";
      keyInput.type = shown ? "password" : "text";
      keyToggle.textContent = shown ? "显示" : "隐藏";
    });
    const clearKey = element("input", { type: "checkbox", dataset: { clearKey: "" } });
    clearKey.addEventListener("change", () => { editing.clearApiKey = clearKey.checked; });

    const grid = element("div", { class: "model-form-grid" },
      element("label", { class: "model-form-field" }, element("span", { text: "供应商编号" }), providerIdField),
      element("label", { class: "model-form-field" }, element("span", { text: "显示名称" }), nameField),
      element("label", { class: "model-form-field" }, element("span", { text: "Base URL" }), baseUrlField),
      element("label", { class: "model-form-field" }, element("span", { text: "接口协议" }), apiField),
    );
    const keyRow = element("div", { class: "model-key-row" },
      element("label", { class: "model-form-field" }, element("span", { text: "API 密钥（只写）" }), element("div", { class: "model-key-input" }, keyInput, keyToggle)),
      element("label", { class: "model-clear-key" }, clearKey, element("span", { text: "清除已保存密钥" })),
    );

    const modelRows = element("div", { class: "model-editor-list" });
    editing.models.forEach((model, index) => modelRows.append(modelEditorRow(model, index)));
    const addModel = element("button", { type: "button", class: "model-add-model-button", text: "+ 添加模型", dataset: { addModelRow: "" } });
    addModel.addEventListener("click", () => {
      editing.models.push(modelDraft({ input: ["text"] }));
      renderEditor();
    });
    const discover = element("button", { type: "button", class: "model-secondary-button", text: "获取可用模型", dataset: { discoverModels: "" } });
    discover.addEventListener("click", () => void discoverModels());
    const modelSection = element("section", { class: "model-editor-section" },
      element("div", { class: "model-editor-section__head" }, element("h4", { text: "模型列表" }), discover, addModel),
      modelRows,
      renderCandidates(),
    );

    const deleteButton = element("button", {
      type: "button",
      class: "model-danger-button",
      text: pendingDeleteProvider === editing.providerId ? "确认删除提供商" : "删除提供商",
      hidden: !editing.original,
      dataset: { providerDelete: "" },
    });
    deleteButton.addEventListener("click", () => void deleteProvider());
    const saveButton = element("button", { type: "submit", class: "model-primary-button", text: "保存提供商", dataset: { saveProvider: "" } });
    const cancelButton = element("button", { type: "button", text: "取消", dataset: { providerCancel: "" } });
    cancelButton.addEventListener("click", closeEditor);
    const editorStatus = element("span", { class: "model-form-status", "data-editor-status": "", role: "status" });

    const goDiscover = () => void discoverModels();
    const form = element("form", { class: "model-provider-form", autocomplete: "off", novalidate: true },
      element("div", { class: "model-editor-head" },
        element("div", {},
          element("h3", { text: editing.original ? "编辑提供商" : "添加模型提供商" }),
          element("p", { class: "model-editor-route", text: editing.original ? editing.providerId : "新的 providers 条目" }),
        ),
      ),
      grid,
      keyRow,
      element("p", { class: "model-note", text: editing.apiKey ? "保存后将写入 models.json；页面不会回显已存密钥。" : credentialHint(editing.original ? catalog.providers.find((item) => item.id === editing.providerId) : null) }),
      modelSection,
      element("div", { class: "model-form-actions" }, saveButton, cancelButton, deleteButton, editorStatus),
    );
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void saveProvider(form);
    });
    // discover button needs the latest form values; attach after form creation.
    discover.onclick = goDiscover;
    editor.replaceChildren(form);
  }

  async function discoverModels() {
    if (!editing || busy || loading) return;
    const providerId = editing.providerId.trim();
    const baseUrl = editing.baseUrl.trim();
    const protocol = editing.api;
    if (!baseUrl || !protocol) {
      showEditorStatus("先填写 Base URL 与接口协议。", true);
      return;
    }
    const editorStatus = editor.querySelector("[data-editor-status]");
    if (editorStatus) editorStatus.textContent = "正在获取模型目录……";
    setPageBusy(true);
    try {
      const result = await api.discoverModels({
        providerId: providerId || undefined,
        baseUrl,
        api: protocol,
        apiKey: editing.apiKey || undefined,
      });
      const existing = new Set(editing.models.map((model) => model.id));
      candidates = (result?.models ?? []).map((model) => ({
        id: model.id,
        name: model.name ?? "",
        checked: !existing.has(model.id),
      }));
      if (!candidates.length) {
        if (editorStatus) editorStatus.textContent = "远端没有返回可用模型。";
      } else {
        renderEditor();
      }
    } catch (error) {
      if (editorStatus) editorStatus.textContent = `获取失败：${error.message}`;
    } finally {
      setPageBusy(false);
    }
  }

  function showEditorStatus(text, isError = false) {
    const node = editor.querySelector("[data-editor-status]");
    if (!node) return;
    node.textContent = text;
    node.dataset.state = isError ? "error" : "";
  }

  async function saveProvider(form) {
    if (!editing || busy || loading) return;
    const providerId = editing.providerId.trim();
    if (!providerId) {
      showEditorStatus("请填写供应商编号。", true);
      return;
    }
    const seen = new Set();
    for (const model of editing.models) {
      const id = String(model.id ?? "").trim();
      if (!id) {
        showEditorStatus("每个模型都需要填写模型编号。", true);
        return;
      }
      if (seen.has(id)) {
        showEditorStatus(`模型编号重复：${id}。`, true);
        return;
      }
      seen.add(id);
    }
    showEditorStatus("正在保存……");
    setPageBusy(true);
    try {
      const result = await api.saveProvider({
        providerId,
        provider: { name: editing.name, baseUrl: editing.baseUrl, api: editing.api },
        apiKey: editing.apiKey,
        clearApiKey: editing.clearApiKey,
        models: editing.models,
      });
      closeEditor();
      await show();
      showStatus(`已${result?.action === "updated" ? "更新" : "新增"}提供商 ${result?.providerId ?? providerId}。${result?.warning ? ` ${result.warning}` : ""}`);
      await refreshModels();
    } catch (error) {
      showEditorStatus(`保存失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
    }
  }

  async function deleteProvider() {
    if (!editing || !editing.original || busy || loading) return;
    if (pendingDeleteProvider !== editing.providerId) {
      pendingDeleteProvider = editing.providerId;
      renderEditor();
      showEditorStatus("再次点击确认删除该提供商及其全部模型。");
      return;
    }
    const providerId = editing.providerId;
    pendingDeleteProvider = "";
    setPageBusy(true);
    try {
      const result = await api.deleteProvider(providerId);
      closeEditor();
      await show();
      showStatus(`已删除提供商 ${result?.providerId ?? providerId}${result?.modelCount ? `，同时移除 ${result.modelCount} 个模型` : ""}。${result?.warning ? ` ${result.warning}` : ""}`);
      await refreshModels();
    } catch (error) {
      pendingDeleteProvider = "";
      renderEditor();
      showEditorStatus(`删除失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
    }
  }

  async function setDefault(providerId, modelId) {
    if (busy || loading) return;
    setPageBusy(true);
    try {
      await api.setDefaultModel(providerId, modelId);
      await show();
      showStatus(`已将 ${providerId}/${modelId} 设为新对话默认。`);
    } catch (error) {
      showStatus(`设置默认失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
      await refreshModels();
    }
  }

  /* ------------------------------ 读取与交互 ------------------------------ */

  async function show() {
    const token = ++sequence;
    loading = true;
    update();
    showStatus("正在读取 Pi 模型配置……");
    try {
      const config = await api.readModelConfiguration();
      if (token !== sequence) return;
      modelsPath = config.modelsPath;
      const [listingResult, catalogResult, infoResult] = await Promise.all([
        api.listModels().then((value) => ({ value }), (error) => ({ error })),
        api.readModelCatalog().then((value) => ({ value }), (error) => ({ error })),
        api.getSessionInfo().then((value) => ({ value }), (error) => ({ error })),
      ]);
      if (token !== sequence) return;
      if (catalogResult.value) catalog = catalogResult.value;
      runtimeModels = listingResult.value?.models ?? [];
      defaults = {
        provider: listingResult.value?.defaultProvider ?? "",
        modelId: listingResult.value?.defaultModel ?? "",
      };
      info = infoResult.value ?? { provider: "", modelId: "" };
      const problems = [
        listingResult.error ? `可用模型读取失败：${listingResult.error.message}` : "",
        catalogResult.error ? `模型配置文件读取失败：${catalogResult.error.message}` : "",
        infoResult.error ? `当前模型读取失败：${infoResult.error.message}` : "",
      ].filter(Boolean);
      warning.hidden = problems.length === 0;
      warning.textContent = problems.join(" ");
      draw();
      showStatus("");
    } catch (error) {
      if (token !== sequence) return;
      warning.hidden = false;
      warning.textContent = `读取失败：${error.message} 可打开配置文件修正后重新读取。`;
      list.replaceChildren();
      empty.hidden = false;
      stateBadge.textContent = "配置读取失败";
      stateBadge.dataset.state = "error";
      currentName.textContent = "模型暂不可用";
      showStatus("");
    } finally {
      if (token === sequence) {
        loading = false;
        update();
      }
    }
  }

  function hide() {
    closeEditor();
    status.textContent = "";
    warning.hidden = true;
  }

  addButton.addEventListener("click", () => openEditor("", false));

  copyButton.addEventListener("click", async () => {
    if (!modelsPath) return;
    try {
      await navigator.clipboard.writeText(modelsPath);
      showStatus("配置文件路径已复制。");
    } catch {
      showStatus("无法写入剪贴板，请手动选择路径。", true);
    }
  });

  openButton.addEventListener("click", async () => {
    if (busy || loading) return;
    setPageBusy(true);
    try {
      await api.openModelsConfiguration();
      showStatus("已打开 models.json；编辑保存后点击「重新读取模型」。");
    } catch (error) {
      showStatus(`打开失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
    }
  });

  reloadButton.addEventListener("click", async () => {
    if (busy || loading) return;
    setPageBusy(true);
    try {
      const result = await api.reloadModels();
      await show();
      await refreshModels();
      showStatus(`模型配置已重新读取，共 ${result?.models?.length ?? 0} 个可用模型。`);
    } catch (error) {
      showStatus(`重新读取失败：${error.message}`, true);
    } finally {
      setPageBusy(false);
    }
  });

  return { show, hide, setBusy };
}
