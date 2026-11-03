import { createProviderAuthPanel } from "./model/provider-auth.js";
import { createCatalogTools } from "./model/catalog-tools.js";
import { createCatalogEnrichmentPanel } from "./model/catalog-enrichment.js";
import { createProviderNavigation } from "./model/provider-navigation.js";

export function createModelSettingsPanel(dialog, openButton, api, setPageBusy, refreshProfiles, canClose = () => true) {
  const form = dialog.querySelector("form");
  const fields = form.querySelector("fieldset");
  const controls = dialog.querySelector("[data-saved-controls]");
  const savedSelect = dialog.querySelector("[data-profiles]");
  const selectedInfo = dialog.querySelector("[data-selected-info]");
  const status = dialog.querySelector("[data-model-status]");
  const closeButton = dialog.querySelector("[data-close]");
  const retryButton = dialog.querySelector("[data-retry]");
  const applyButton = dialog.querySelector("[data-apply]");
  const defaultButton = dialog.querySelector("[data-default]");
  const clearDefaultButton = dialog.querySelector("[data-clear-default]");
  const hideButton = dialog.querySelector("[data-hide]");
  const editButton = dialog.querySelector("[data-edit]");
  const cancelEditButton = dialog.querySelector("[data-cancel-edit]");
  const cloneButton = dialog.querySelector("[data-clone]");
  const refreshProfileButton = dialog.querySelector("[data-refresh-profile]");
  const testButton = dialog.querySelector("[data-test-connection]");
  const environmentButton = dialog.querySelector("[data-environment]");
  const fetchButton = dialog.querySelector("[data-fetch-models]");
  const saveButton = form.querySelector('[type="submit"]');
  const addProviderButton = dialog.querySelector("[data-add-provider]");
  const refreshOfficialButton = dialog.querySelector("[data-refresh-official]");
  const showEnrichmentButton = dialog.querySelector("[data-show-enrichment]");
  const field = (name) => form.elements.namedItem(name);
  let busy = true, loading = false, saving = false, ready = false;
  let sequence = 0;
  let data;
  let editingId = "";
  let unsubscribe;
  const navigation = createProviderNavigation(dialog, selectProvider, id => {
    savedSelect.value = id; describeSelected(); void editSelected();
  });
  const providerAuth = createProviderAuthPanel(dialog.querySelector("[data-provider-auth]"), api, setPageBusy, refreshProfiles);
  const catalogTools = createCatalogTools(dialog.querySelector("[data-catalog-tools]"), api, setPageBusy, async provider => {
    if (field("builtinProvider").value !== provider) return;
    const selectedModel = field("builtinModelId").value;
    const pending = loadModels();
    const token = sequence;
    await pending;
    if (token !== sequence || !dialog.open) return;
    field("builtinModelId").value = selectedModel;
    await refreshThinking();
  });
  const enrichment = createCatalogEnrichmentPanel(dialog.querySelector("[data-enrichment]"), api,
    () => field("kind").value === "custom" ? field("customModelId").value.trim() : "",
    result => {
      for (const name of ["contextWindow", "maxTokens"]) if (!field(name).value && result[name]) field(name).value = result[name];
      for (const name of ["reasoning", "vision"]) if (field(name).dataset.edited !== "true" && result[name] !== undefined) field(name).checked = result[name];
    });
  const thinking = dialog.querySelector("#model-thinking-level");
  const thinkingStatus = dialog.querySelector("[data-thinking-status]");
  let thinkingReady = false;
  async function refreshThinking() {
    if (!api.getSessionInfo) return;
    const token = sequence;
    try {
      const info = await api.getSessionInfo();
      if (!dialog.open || token !== sequence) return;
      thinking.replaceChildren();
      for (const level of info.thinkingLevels ?? ["off"]) option(thinking, level, ({ off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "最高" })[level] ?? level);
      thinking.value = info.thinkingLevel ?? "off"; thinkingReady = true; thinkingStatus.textContent = "";
    } catch { if (!dialog.open || token !== sequence) return; thinkingReady = false; thinkingStatus.textContent = "当前对话尚未就绪，可先配置模型。"; }
    update();
  }

  function update() {
    const custom = field("kind").value === "custom";
    dialog.querySelector("[data-builtin]").hidden = custom;
    dialog.querySelector("[data-custom]").hidden = !custom;
    // 隐藏区域同时禁用，避免原生表单校验要求填写不可见字段。
    dialog.querySelector("[data-builtin]").disabled = custom;
    dialog.querySelector("[data-custom]").disabled = !custom;
    for (const item of field("authMode").options) item.disabled = custom && ["sdk", "oauth"].includes(item.value);
    if (custom && ["sdk", "oauth"].includes(field("authMode").value)) field("authMode").value = "saved";
    field("baseUrl").required = custom;
    const savedKey = field("authMode").value === "saved";
    const canReuseKey = savedKey && data?.profiles.some((item) => item.id === editingId && item.hasSavedKey);
    dialog.querySelector("[data-key]").hidden = !savedKey;
    field("apiKey").disabled = !savedKey;
    field("apiKey").required = savedKey && !canReuseKey;
    fields.disabled = busy || loading || saving || !ready;
    controls.disabled = busy || loading || saving || !ready;
    applyButton.disabled = controls.disabled || !savedSelect.value;
    defaultButton.disabled = controls.disabled || !savedSelect.value || savedSelect.value === data?.defaultProfileId;
    clearDefaultButton.disabled = controls.disabled || (!data?.environment && !data?.profiles.some(item => item.id === "legacy"));
    hideButton.disabled = controls.disabled || !savedSelect.value || savedSelect.value === data?.defaultProfileId;
    editButton.disabled = controls.disabled || !savedSelect.value;
    cloneButton.disabled = controls.disabled || !savedSelect.value;
    refreshProfileButton.disabled = controls.disabled || !savedSelect.value;
    saveButton.disabled = fields.disabled || (savedKey && !canReuseKey && !data?.encryptionAvailable);
    environmentButton.disabled = fields.disabled || !data?.environment ||
      !data.providers.some((item) => item.id === data.environment.provider);
    fetchButton.disabled = fields.disabled;
    testButton.disabled = fields.disabled || !custom;
    showEnrichmentButton.disabled = fields.disabled || !custom;
    addProviderButton.disabled = fields.disabled;
    refreshOfficialButton.disabled = fields.disabled || custom || !field("builtinProvider").value;
    navigation.setBusy(fields.disabled);
    dialog.querySelector("[data-editor-title]").textContent = editingId
      ? `编辑服务商：${field(custom ? "customProvider" : "builtinProvider").value}` : "新增服务商";
    thinking.disabled = busy || loading || saving || !thinkingReady;
    if (data) {
      dialog.querySelector("[data-environment-hint]").textContent = data.environmentError
        ? `.env 配置无效：${data.environmentError}`
        : !data.environment ? ".env 未同时配置 PI_PROVIDER 和 PI_MODEL，可以手动新增配置。"
        : !data.providers.some((item) => item.id === data.environment.provider)
          ? ".env 供应商暂不能填入内置新增表单；可继续使用原有配置，或手动新增兼容接口。"
          : "读取启动时的供应商、模型和地址；密钥不回填。不会切换当前对话或改写 .env。";
    }
    retryButton.disabled = busy || loading || saving;
    closeButton.disabled = saving || !canClose();


    dialog.setAttribute("aria-busy", String(loading || saving));
  }

  function setBusy(value) {
    busy = value;
    openButton.disabled = value;
    providerAuth.setBusy(value);
    catalogTools.setBusy(value);
    enrichment.setBusy(value);
    update();
  }

  function option(select, value, label) {
    const item = document.createElement("option");
    item.value = value; item.textContent = label; select.append(item);
  }

  function renderProfiles(selectedId = savedSelect.value) {
    savedSelect.replaceChildren();
    option(savedSelect, "", "请选择已保存配置");
    for (const item of data.profiles) {
      option(savedSelect, item.id, `${item.name}${item.id === data.defaultProfileId ? "（新对话默认）" : ""}`);
    }
    savedSelect.value = selectedId;
    if (!savedSelect.value) savedSelect.value = data.defaultProfileId;
    describeSelected();
  }

  function describeSelected() {
    const selected = data?.profiles.find((item) => item.id === savedSelect.value);
    selectedInfo.textContent = selected
      ? `${selected.provider} / ${selected.modelId}\n${selected.baseUrl || "使用官方地址"}\n${selected.hasSavedKey ? "已有本机加密密钥" : selected.authMode === "oauth" ? "使用 OAuth 登录" : selected.authMode === "provider" ? "使用供应商激活密钥" : "使用原有 SDK 凭据"}`
      : "选择左侧服务商，或添加自定义服务商。";
    renderNavigation();
    update();
  }

  function renderNavigation() {
    if (data) navigation.render(data, field("kind").value,
      field(field("kind").value === "custom" ? "customProvider" : "builtinProvider").value, savedSelect.value);
  }

  function resetEditor(kind = "custom") {
    editingId = ""; cancelEditButton.hidden = true; form.reset();
    field("kind").value = kind;
    field("apiKey").value = "";
    for (const name of ["reasoning", "vision"]) delete field(name).dataset.edited;
    saveButton.textContent = "保存";
    savedSelect.value = ""; describeSelected();
  }

  async function selectProvider(kind, provider) {
    if (fields.disabled) return;
    const selected = data.profiles.find(item => item.kind === kind && item.provider === provider && item.id === savedSelect.value)
      ?? data.profiles.find(item => item.kind === kind && item.provider === provider);
    if (selected) {
      savedSelect.value = selected.id; describeSelected(); await editSelected();
    } else {
      resetEditor(kind);
      field(kind === "custom" ? "customProvider" : "builtinProvider").value = provider;
      if (kind === "builtin") {
        const capability = data.providers.find(item => item.id === provider);
        field("authMode").value = capability?.supportsApiKey === false && capability.supportsOAuth ? "oauth" : "sdk";
        const pending = loadModels();
        const token = sequence;
        await pending;
        if (token !== sequence || !dialog.open) return;
      }
      renderNavigation(); update(); field("name").focus();
      await refreshThinking();
    }
  }

  async function loadModels() {
    const token = ++sequence;
    loading = true; update();
    field("builtinModelId").replaceChildren();
    option(field("builtinModelId"), "", "请选择模型");
    try {
      if (field("builtinProvider").value) {
        const models = await api.listSettingsModels(field("builtinProvider").value);
        if (token !== sequence || !dialog.open) return;
        for (const item of models) option(field("builtinModelId"), item.id, `${item.name} · ${item.id}`);
      }
      if (token === sequence) status.textContent = "可以新增配置，或将已保存配置应用到当前对话。";
    } catch (error) {
      if (token === sequence) status.textContent = `模型目录读取失败：${error.message}；可重新选择供应商重试。`;
    } finally {
      if (token === sequence) { loading = false; update(); }
    }
  }

  async function load() {
    const token = ++sequence;
    loading = true; ready = false; retryButton.hidden = true;
    status.textContent = "正在读取配置……"; update();
    try {
      const result = await api.readModelSettings();
      if (token !== sequence || !dialog.open) return;
      data = result;
      editingId = "";
      cancelEditButton.hidden = true;
      saveButton.textContent = "保存";
      form.reset();
      for (const name of ["reasoning", "vision"]) delete field(name).dataset.edited;
      field("apiKey").value = "";
      field("builtinProvider").replaceChildren();
      option(field("builtinProvider"), "", "请选择供应商");
      for (const item of data.providers) option(field("builtinProvider"), item.id, `${item.name} · ${item.id}`);
      field("builtinModelId").replaceChildren();
      option(field("builtinModelId"), "", "请先选择供应商");
      ready = true;
      renderProfiles();
      catalogTools.load(data);
      void providerAuth.load(data).catch(error => { status.textContent = error.message; });
      void enrichment.load().catch(error => { status.textContent = error.message; });
      loading = false;
      if (savedSelect.value) void editSelected(false);
      else { resetEditor(); void refreshThinking(); }
      status.textContent = data.encryptionAvailable
        ? "保存新增配置后，可立即切换；设为默认只影响以后新建的对话。"
        : "系统密钥保护不可用，暂不能保存新密钥。";
    } catch (error) {
      if (token !== sequence || !dialog.open) return;
      status.textContent = `读取失败：${error.message}`; retryButton.hidden = false;
    } finally {
      if (token === sequence) { loading = false; update(); }
    }
  }

  async function mutate(action, success) {
    if (busy || loading || saving || !ready) return;
    saving = true; setPageBusy(true); update();
    status.textContent = "正在处理……";
    let completed = false;
    try {
      const result = await action();
      completed = true;
      data = await api.readModelSettings();
      renderProfiles(result?.id ?? savedSelect.value);
      if (result?.id) await editSelected(false);
      else if (editingId && !data.profiles.some(item => item.id === editingId)) resetEditor();
      await refreshProfiles();
      await refreshThinking();
      status.textContent = success;
    } catch (error) {
      status.textContent = `${completed ? "操作已完成，刷新失败" : "操作未完成"}：${error.message}`;
      // SDK 可能在报错前已切换模型，必须重新读取实际会话状态。
      try { await refreshProfiles(); } catch (refreshError) { status.textContent += `；状态核对失败：${refreshError.message}`; }
    } finally {
      field("apiKey").value = "";
      saving = false; setPageBusy(false); update(); closeButton.focus();
    }
  }

  function close() {
    if (saving || !canClose()) return;
    sequence += 1; loading = false; field("apiKey").value = "";
    providerAuth.close(); enrichment.close(); unsubscribe?.(); unsubscribe = undefined;
    dialog.close(); if (!openButton.disabled) openButton.focus();
  }
  openButton.addEventListener("click", () => {
    if (openButton.disabled || dialog.open) return;
    document.getElementById("conversation-menu").open = false;
    unsubscribe = api.onModelSettingsEvent?.(event => { providerAuth.onEvent(event); enrichment.onEvent(event); if (event.type === "error") status.textContent = event.message; });
    dialog.showModal(); void load();
  });
  closeButton.addEventListener("click", close);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.isComposing) event.preventDefault();
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  savedSelect.addEventListener("change", () => { describeSelected(); void editSelected(); });
  addProviderButton.addEventListener("click", () => {
    if (addProviderButton.disabled) return;
    resetEditor(); field("customProvider").focus();
  });
  refreshOfficialButton.addEventListener("click", () => {
    if (refreshOfficialButton.disabled) return;
    const catalog = dialog.querySelector("[data-catalog-tools]");
    catalog.open = true;
    catalog.querySelector("[data-catalog-provider]").value = field("builtinProvider").value;
    catalogTools.setBusy(false);
    catalog.querySelector("[data-refresh-builtin]").click();
    catalog.scrollIntoView({ block: "nearest" });
  });
  showEnrichmentButton.addEventListener("click", () => {
    if (showEnrichmentButton.disabled) return;
    const section = dialog.querySelector("[data-enrichment]");
    section.open = true; section.scrollIntoView({ block: "nearest" });
    section.querySelector("textarea").focus();
  });
  retryButton.addEventListener("click", () => { if (!retryButton.disabled) void load(); });
  field("kind").addEventListener("change", () => { field("apiKey").value = ""; renderNavigation(); update(); });
  field("customProvider").addEventListener("change", () => { renderNavigation(); update(); });
  field("authMode").addEventListener("change", () => { field("apiKey").value = ""; update(); });
  field("builtinProvider").addEventListener("change", () => {
    field("apiKey").value = "";
    const capability = data?.providers.find(item => item.id === field("builtinProvider").value);
    if (capability?.supportsApiKey === false && capability.supportsOAuth) field("authMode").value = "oauth";
    renderNavigation();
    void loadModels();
  });
  fetchButton.addEventListener("click", async () => {
    if (fetchButton.disabled) return;
    const token = ++sequence;
    loading = true; update();
    status.textContent = "正在获取模型列表……";
    try {
      const models = await api.fetchModelCatalog({ baseUrl: field("baseUrl").value, apiKey: field("apiKey").value, api: field("api").value, profileId: editingId || undefined, provider: field("authMode").value === "provider" ? field("customProvider").value : undefined });
      if (token !== sequence || !dialog.open) return;
      const options = dialog.querySelector("#profile-model-options");
      options.replaceChildren();
      for (const id of models) option(options, id, id);
      status.textContent = models.length ? `已获取 ${models.length} 个模型。` : "服务商未返回模型。";
    } catch (error) {
      if (token === sequence && dialog.open) status.textContent = `获取模型列表失败：${error.message}`;
    } finally {
      if (token === sequence) { loading = false; update(); }
    }
  });
  testButton.addEventListener("click", () => {
    if (testButton.disabled) return;
    void mutate(async () => {
      const result = await api.testModelConnection({ baseUrl: field("baseUrl").value, apiKey: field("apiKey").value, api: field("api").value,
        profileId: editingId || undefined, provider: field("authMode").value === "provider" ? field("customProvider").value : undefined });
      status.textContent = `列表连接成功：${result.count} 个模型，${result.latencyMs} ms。`;
      return result;
    }, "列表连接成功；真实模型调用和额度仍由服务商决定。");
  });
  environmentButton.addEventListener("click", async () => {
    if (environmentButton.disabled) return;
    const environment = data.environment;
    field("kind").value = "builtin";
    field("name").value = `.env · ${environment.modelId}`.slice(0, 80);
    field("builtinProvider").value = environment.provider;
    field("baseUrl").value = environment.baseUrl;
    field("authMode").value = data.providers.find(item => item.id === environment.provider)?.supportsApiKey === false ? "oauth" : "sdk";
    field("apiKey").value = "";
    const pending = loadModels();
    const token = sequence;
    await pending;
    if (token !== sequence || !dialog.open) return;
    field("builtinModelId").value = environment.modelId;
    status.textContent = field("builtinModelId").value
      ? "已读取启动时的 .env 模型配置，保存为新配置后即可选择；密钥由运行时读取。"
      : ".env 的模型 ID 未登记，请核对模型 ID；未自动替换为其他模型。";
  });
  applyButton.addEventListener("click", () => {
    if (!applyButton.disabled) void mutate(() => api.switchModelProfile(savedSelect.value), "已切换当前对话的模型配置，输入与文件草稿保留。");
  });
  defaultButton.addEventListener("click", () => {
    if (!defaultButton.disabled) void mutate(() => api.setDefaultModelProfile(savedSelect.value), "已设为新对话默认；当前对话保持原配置。");
  });
  clearDefaultButton.addEventListener("click", () => {
    if (!clearDefaultButton.disabled) void mutate(() => api.clearDefaultModelProfile(), "已恢复原有默认配置；当前对话保持原选择。");
  });
  hideButton.addEventListener("click", () => {
    if (hideButton.disabled || !window.confirm("移除后不再显示此配置，已有对话仍可使用。确定移除吗？")) return;
    void mutate(() => api.hideModelProfile(savedSelect.value), "配置已移除，已有对话仍可使用。");
  });
  cloneButton.addEventListener("click", () => {
    if (cloneButton.disabled) return;
    const selected = data.profiles.find(item => item.id === savedSelect.value);
    const name = window.prompt("新配置名称", `${selected.name} 副本`);
    if (name?.trim()) void mutate(() => api.cloneModelProfile(selected.id, name), "配置已复制，地址、模型参数和凭据已保留。");
  });
  refreshProfileButton.addEventListener("click", () => {
    if (refreshProfileButton.disabled) return;
    void mutate(async () => {
      const result = await api.refreshProfileModels(savedSelect.value);
      const list = dialog.querySelector("[data-profile-catalog]");
      list.hidden = false; list.textContent = `可用模型（${result.total}）：\n${result.models.map(item => item.id).join("\n")}`;
      const options = dialog.querySelector("#profile-model-options"); options.replaceChildren();
      for (const item of result.models) option(options, item.id, item.id);
    }, "模型列表已刷新，已有模型参数保留。编辑配置时可选择新模型。");
  });
  thinking.addEventListener("change", () => {
    if (thinking.disabled) return;
    void mutate(async () => { await api.setThinkingLevel(thinking.value); await refreshThinking(); }, "已更新当前对话的思考强度。");
  });
  for (const name of ["reasoning", "vision"]) field(name).addEventListener("change", () => { field(name).dataset.edited = "true"; });
  async function editSelected(focus = true) {
    const selected = data.profiles.find((item) => item.id === savedSelect.value);
    if (!selected) return;
    editingId = selected.id;
    cancelEditButton.hidden = false;
    saveButton.textContent = "保存修改";
    field("name").value = selected.name;
    field("kind").value = selected.kind;
    field("baseUrl").value = selected.baseUrl;
    field("authMode").value = selected.authMode;
    field("apiKey").value = "";
    if (selected.kind === "custom") {
      field("customProvider").value = selected.provider;
      field("customModelId").value = selected.modelId;
      field("api").value = selected.api;
      field("contextWindow").value = selected.contextWindow;
      field("maxTokens").value = selected.maxTokens;
      field("reasoning").checked = selected.reasoning;
      field("vision").checked = selected.vision;
      for (const name of ["reasoning", "vision"]) field(name).dataset.edited = "true";
    } else {
      field("builtinProvider").value = selected.provider;
      const pending = loadModels();
      const token = sequence;
      await pending;
      if (token !== sequence || !dialog.open || editingId !== selected.id) return;
      field("builtinModelId").value = selected.modelId;
    }
    renderNavigation(); update();
    if (focus) field("name").focus();
    await refreshThinking();
  }
  editButton.addEventListener("click", () => {
    if (!editButton.disabled) void editSelected();
  });
  cancelEditButton.addEventListener("click", () => {
    resetEditor();
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault(); if (saveButton.disabled) return;
    const custom = field("kind").value === "custom";
    const input = {
      name: field("name").value, kind: field("kind").value,
      provider: field(custom ? "customProvider" : "builtinProvider").value,
      modelId: field(custom ? "customModelId" : "builtinModelId").value,
      baseUrl: field("baseUrl").value,
      authMode: field("authMode").value,
      apiKey: field("apiKey").value,
      api: field("api").value,
      contextWindow: Number(field("contextWindow").value), maxTokens: Number(field("maxTokens").value),
      replaceId: editingId,
      reasoning: field("reasoning").checked, vision: field("vision").checked,
    };
    void mutate(async () => {
      const result = await api.saveModelSettings(input);
      editingId = ""; cancelEditButton.hidden = true; saveButton.textContent = "保存";
      return result;
    }, "配置已保存。选择“用于当前对话”即可切换。");
  });
  return { setBusy };
}
