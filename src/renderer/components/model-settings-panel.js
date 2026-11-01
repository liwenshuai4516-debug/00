export function createModelSettingsPanel(dialog, openButton, api, setPageBusy, refreshProfiles) {
  const form = dialog.querySelector("form");
  const fields = form.querySelector("fieldset");
  const controls = dialog.querySelector("[data-saved-controls]");
  const savedSelect = dialog.querySelector("[data-profiles]");
  const selectedInfo = dialog.querySelector("[data-selected-info]");
  const status = dialog.querySelector('[role="status"]');
  const closeButton = dialog.querySelector("[data-close]");
  const retryButton = dialog.querySelector("[data-retry]");
  const applyButton = dialog.querySelector("[data-apply]");
  const defaultButton = dialog.querySelector("[data-default]");
  const environmentButton = dialog.querySelector("[data-environment]");
  const saveButton = form.querySelector('[type="submit"]');
  const field = (name) => form.elements.namedItem(name);
  let busy = true, loading = false, saving = false, ready = false;
  let sequence = 0;
  let data;

  function update() {
    const custom = field("kind").value === "custom";
    dialog.querySelector("[data-builtin]").hidden = custom;
    dialog.querySelector("[data-custom]").hidden = !custom;
    // 隐藏区域同时禁用，避免原生表单校验要求填写不可见字段。
    dialog.querySelector("[data-builtin]").disabled = custom;
    dialog.querySelector("[data-custom]").disabled = !custom;
    field("authMode").disabled = custom;
    field("baseUrl").required = custom;
    const savedKey = custom || field("authMode").value === "saved";
    dialog.querySelector("[data-key]").hidden = !savedKey;
    field("apiKey").disabled = !savedKey;
    field("apiKey").required = savedKey;
    fields.disabled = busy || loading || saving || !ready;
    controls.disabled = busy || loading || saving || !ready;
    applyButton.disabled = controls.disabled || !savedSelect.value;
    defaultButton.disabled = controls.disabled || !savedSelect.value || savedSelect.value === data?.defaultProfileId;
    saveButton.disabled = fields.disabled || (savedKey && !data?.encryptionAvailable);
    environmentButton.disabled = fields.disabled || !data?.environment ||
      !data.providers.some((item) => item.id === data.environment.provider);
    if (data) {
      dialog.querySelector("[data-environment-hint]").textContent = data.environmentError
        ? `.env 配置无效：${data.environmentError}`
        : !data.environment ? ".env 未同时配置 PI_PROVIDER 和 PI_MODEL，可以手动新增配置。"
        : !data.providers.some((item) => item.id === data.environment.provider)
          ? ".env 供应商暂不能填入内置新增表单；可继续使用原有配置，或手动新增兼容接口。"
          : "读取启动时的供应商、模型和地址；密钥不回填。不会切换当前对话或改写 .env。";
    }
    retryButton.disabled = busy || loading || saving;
    closeButton.disabled = saving;
    dialog.setAttribute("aria-busy", String(loading || saving));
  }

  function setBusy(value) {
    busy = value;
    openButton.disabled = value;
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
      ? `${selected.provider} / ${selected.modelId}\n${selected.baseUrl || "使用 SDK 地址"}\n${selected.hasSavedKey ? "已有本机加密密钥" : "使用原有 SDK 凭据"}`
      : "可以在下方新增配置。";
    update();
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
      form.reset();
      field("apiKey").value = "";
      field("builtinProvider").replaceChildren();
      option(field("builtinProvider"), "", "请选择供应商");
      for (const item of data.providers) option(field("builtinProvider"), item.id, `${item.name} · ${item.id}`);
      field("builtinModelId").replaceChildren();
      option(field("builtinModelId"), "", "请先选择供应商");
      ready = true;
      renderProfiles();
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
      await refreshProfiles();
      status.textContent = success;
    } catch (error) {
      status.textContent = `${completed ? "操作已完成，刷新失败" : "操作未完成"}：${error.message}`;
      // SDK 可能在报错前已切换模型，必须重新读取实际会话状态。
      await refreshProfiles();
    } finally {
      field("apiKey").value = "";
      saving = false; setPageBusy(false); update(); closeButton.focus();
    }
  }

  function close() {
    if (saving) return;
    sequence += 1; loading = false; field("apiKey").value = "";
    dialog.close(); if (!openButton.disabled) openButton.focus();
  }
  openButton.addEventListener("click", () => {
    if (openButton.disabled || dialog.open) return;
    document.getElementById("conversation-menu").open = false;
    dialog.showModal(); void load();
  });
  closeButton.addEventListener("click", close);
  dialog.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && event.isComposing) event.preventDefault();
  });
  dialog.addEventListener("cancel", (event) => { event.preventDefault(); close(); });
  savedSelect.addEventListener("change", describeSelected);
  retryButton.addEventListener("click", () => { if (!retryButton.disabled) void load(); });
  field("kind").addEventListener("change", () => { field("apiKey").value = ""; update(); });
  field("authMode").addEventListener("change", () => { field("apiKey").value = ""; update(); });
  field("builtinProvider").addEventListener("change", () => { field("apiKey").value = ""; void loadModels(); });
  environmentButton.addEventListener("click", async () => {
    if (environmentButton.disabled) return;
    const environment = data.environment;
    field("kind").value = "builtin";
    field("name").value = `.env · ${environment.modelId}`.slice(0, 80);
    field("builtinProvider").value = environment.provider;
    field("baseUrl").value = environment.baseUrl;
    field("authMode").value = "sdk";
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
  form.addEventListener("submit", (event) => {
    event.preventDefault(); if (saveButton.disabled) return;
    const custom = field("kind").value === "custom";
    const input = {
      name: field("name").value, kind: field("kind").value,
      provider: field(custom ? "customProvider" : "builtinProvider").value,
      modelId: field(custom ? "customModelId" : "builtinModelId").value,
      baseUrl: field("baseUrl").value,
      authMode: custom ? "saved" : field("authMode").value,
      apiKey: field("apiKey").value,
      api: field("api").value,
      contextWindow: Number(field("contextWindow").value), maxTokens: Number(field("maxTokens").value),
    };
    void mutate(() => api.saveModelSettings(input), "已保存为新配置。选择“用于当前对话”即可切换。");
  });
  return { setBusy };
}
