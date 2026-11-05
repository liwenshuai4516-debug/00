import { formatContextUsage } from "../session-info-panel.js";

// 思考强度使用 Pi 的原始级别编号，页面只负责给出中文名称。
const LEVEL_LABELS = {
  off: "关闭",
  minimal: "最低",
  low: "低",
  medium: "中",
  high: "高",
  xhigh: "最高",
  max: "最大",
};

// 未标记 reasoning 的模型只有关闭一档，默认给出常见四档便于勾选。
const DEFAULT_REASONING_LEVELS = ["off", "minimal", "low", "medium", "high"];

function formatTokens(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return "";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(value % 1_000_000 ? 1 : 0))}M`;
  if (value >= 1000) return `${Number((value / 1000).toFixed(value % 1000 ? 1 : 0))}K`;
  return String(value);
}

function option(value, label) {
  const element = document.createElement("option");
  element.value = value;
  element.textContent = label;
  return element;
}

function chip(text, extraClass) {
  const element = document.createElement("span");
  element.className = extraClass ? `model-chip ${extraClass}` : "model-chip";
  element.textContent = text;
  return element;
}

// 设置页只展示已有接口返回的字段：配置路径、当前会话信息、可用模型目录与可编辑的 models.json 内容。
export function createModelProviders(panel, api, setPageBusy, refreshModels) {
  const path = panel.querySelector("[data-models-path]");
  const current = panel.querySelector("[data-current-model]");
  const currentName = panel.querySelector("[data-current-model-name]");
  const currentProvider = panel.querySelector("[data-current-provider]");
  const currentContext = panel.querySelector("[data-current-context]");
  const currentTags = panel.querySelector("[data-current-tags]");
  const defaultLabel = panel.querySelector("[data-default-model]");
  const state = panel.querySelector("[data-model-state]");
  const count = panel.querySelector("[data-model-count]");
  const catalogList = panel.querySelector("[data-model-catalog]");
  const empty = panel.querySelector("[data-models-empty]");
  const warning = panel.querySelector("[data-models-warning]");
  const status = panel.querySelector("[data-provider-status]");
  const thinking = panel.querySelector("#model-thinking-level");
  const thinkingHint = panel.querySelector("[data-thinking-hint]");
  const enableThinking = panel.querySelector("[data-enable-thinking]");
  const copyButton = panel.querySelector("[data-copy-models-path]");
  const addButton = panel.querySelector("[data-add-model]");
  const addProviderButton = panel.querySelector("[data-add-provider]");
  const defaultButton = panel.querySelector("[data-default-model-button]");
  const editor = panel.querySelector("[data-model-editor]");
  const form = panel.querySelector("[data-model-form]");
  const editorTitle = panel.querySelector("[data-editor-title]");
  const editorHint = panel.querySelector("[data-editor-hint]");
  const editorStatus = panel.querySelector("[data-editor-status]");
  const providerIdField = form.querySelector('[data-field="providerId"]');
  const providerIdWrapper = form.querySelector("[data-provider-id-field]");
  const thinkingLevelsBox = form.querySelector("[data-thinking-levels]");
  const field = (name) => form.querySelector(`[data-field="${name}"]`);
  const providerEditor = panel.querySelector("[data-provider-editor]");
  const providerForm = panel.querySelector("[data-provider-form]");
  const providerEditorTitle = panel.querySelector("[data-provider-editor-title]");
  const providerEditorStatus = panel.querySelector("[data-provider-editor-status]");
  const providerDeleteButton = panel.querySelector("[data-provider-delete]");
  const providerField = (name) => providerForm.querySelector(`[data-provider-field="${name}"]`);

  let busy = true;
  let loading = false;
  let sequence = 0;
  let levels = [];
  let modelsPath = "";
  let catalog = { providers: [], options: { api: [], thinkingLevels: [], inputs: [] } };
  let models = [];
  let defaults = { provider: "", modelId: "" };
  let currentModel = { provider: "", modelId: "" };
  let editing = null;
  let pendingDelete = "";
  let editingProvider = "";
  let pendingProviderDelete = "";

  function update() {
    const disabled = busy || loading;
    for (const button of panel.querySelectorAll("button")) button.disabled = disabled;
    copyButton.disabled = disabled || !modelsPath;
    thinking.disabled = disabled || levels.length <= 1;
  }

  /* ------------------------------ 当前对话 ------------------------------ */

  function drawThinking(info) {
    levels = info.thinkingLevels?.length ? info.thinkingLevels : ["off"];
    thinking.replaceChildren(...levels.map((level) => option(level, LEVEL_LABELS[level] ?? level)));
    thinking.value = info.thinkingLevel ?? "off";
    const adjustable = levels.length > 1;
    // 模型没有思考档位时给出直达入口，而不是留一个永远灰掉的控件。
    enableThinking.hidden = adjustable;
    thinkingHint.textContent = adjustable
      ? "只影响当前对话，并按模型记住上次选择。"
      : "当前模型未标记支持思考强度；点击开启后可在 models.json 中补上该能力。";
  }

  function drawCurrent(info, listing) {
    const matched = models.find(
      (model) => model.provider === info.provider && model.id === info.modelId,
    );
    current.textContent = `${info.provider}/${info.modelId}`;
    currentProvider.textContent = info.provider || "未选择";
    currentContext.textContent = formatContextUsage(info.contextUsage).replace(/^上下文估算：/, "");
    currentName.textContent = matched?.name || info.modelId || "未选择模型";

    const isDefault = defaults.provider === info.provider && defaults.modelId === info.modelId;
    currentTags.replaceChildren();
    if (isDefault) currentTags.append(chip("新对话默认", "is-accent"));
    if (matched?.reasoning) currentTags.append(chip("推理"));

    const defaultText = defaults.provider && defaults.modelId ? `${defaults.provider}/${defaults.modelId}` : "未设置";
    defaultLabel.textContent = defaultText;
    defaultLabel.title = defaultText;

    const known = Boolean(matched);
    state.textContent = !listing.length ? "无可用模型" : known ? "已就绪" : "当前模型不在目录中";
    state.dataset.state = known ? "ok" : "warn";
  }

  /* ------------------------------ 模型目录 ------------------------------ */

  function providerTitle(providerId) {
    const configured = catalog.providers.find((item) => item.id === providerId);
    return configured?.name || providerId;
  }

  function hasConfigEntry(providerId, modelId) {
    return catalog.providers.some(
      (provider) => provider.id === providerId && provider.models.some((model) => model.id === modelId),
    );
  }

  function buildRow(model) {
    const isCurrent = model.provider === currentModel.provider && model.id === currentModel.modelId;
    const isDefault = model.provider === defaults.provider && model.id === defaults.modelId;
    const item = document.createElement("li");
    item.className = "model-row";
    item.dataset.provider = model.provider;
    item.dataset.modelId = model.id;
    if (isCurrent) item.classList.add("is-current");

    const head = document.createElement("div");
    head.className = "model-row-head";
    const name = document.createElement("span");
    name.className = "model-row-name";
    name.textContent = model.name || model.id;
    head.append(name);
    if (model.id && model.id !== model.name) {
      const id = document.createElement("code");
      id.className = "model-row-id";
      id.textContent = model.id;
      head.append(id);
    }
    if (isCurrent) head.append(chip("当前", "is-current"));
    if (isDefault) head.append(chip("默认", "is-accent"));

    const meta = document.createElement("div");
    meta.className = "model-row-meta";
    const contextWindow = formatTokens(model.contextWindow);
    const maxTokens = formatTokens(model.maxTokens);
    if (contextWindow) meta.append(chip(`上下文 ${contextWindow}`));
    if (maxTokens) meta.append(chip(`输出 ${maxTokens}`));
    if (model.reasoning) meta.append(chip("推理", "is-accent"));
    if (model.input?.includes("image")) meta.append(chip("图片"));

    const actions = document.createElement("div");
    actions.className = "model-row-actions";
    if (!isDefault) {
      const makeDefault = document.createElement("button");
      makeDefault.type = "button";
      makeDefault.dataset.action = "default";
      makeDefault.textContent = "设为默认";
      actions.append(makeDefault);
    }
    const edit = document.createElement("button");
    edit.type = "button";
    edit.dataset.action = "edit";
    edit.textContent = "编辑";
    actions.append(edit);
    // 只有 models.json 中真实存在的条目才能删除，内置模型需先写入覆盖条目。
    if (hasConfigEntry(model.provider, model.id)) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.dataset.action = "delete";
      remove.className = "model-danger-button";
      remove.textContent = pendingDelete === `${model.provider}::${model.id}` ? "确认删除" : "删除";
      actions.append(remove);
    }

    const body = document.createElement("div");
    body.className = "model-row-body";
    body.append(head, meta);
    item.append(body, actions);
    return item;
  }

  function providerCredential(providerId) {
    const configured = catalog.providers.find((item) => item.id === providerId);
    if (!configured) return { state: "unknown", title: "该提供商不在 models.json 目录中" };
    return configured.hasApiKey
      ? { state: "configured", title: "models.json 中已配置 apiKey" }
      : { state: "unknown", title: "models.json 未配置 apiKey；环境变量或 auth.json 仍可能提供" };
  }

  function buildProviderCard(providerId, items) {
    const credential = providerCredential(providerId);
    const card = document.createElement("section");
    card.className = "model-catalog-group provider-card";
    card.dataset.providerId = providerId;
    card.dataset.credential = credential.state;

    const head = document.createElement("div");
    head.className = "provider-card__head";

    const dot = document.createElement("span");
    dot.className = "provider-credential-dot";
    dot.dataset.credential = credential.state;
    dot.title = credential.title;
    dot.setAttribute("aria-label", credential.title);

    const heading = document.createElement("h4");
    const title = document.createElement("span");
    title.className = "model-catalog-title";
    title.textContent = providerTitle(providerId);
    const id = document.createElement("code");
    id.textContent = providerId;
    const amount = document.createElement("span");
    amount.className = "model-catalog-count";
    amount.textContent = String(items.length);
    amount.title = `${items.length} 个可用模型`;
    heading.append(title, id, amount);

    const actions = document.createElement("div");
    actions.className = "provider-card__actions";
    const addModel = document.createElement("button");
    addModel.type = "button";
    addModel.dataset.providerAction = "add-model";
    addModel.dataset.providerId = providerId;
    addModel.textContent = "新增模型";
    const editProvider = document.createElement("button");
    editProvider.type = "button";
    editProvider.dataset.providerAction = "edit-provider";
    editProvider.dataset.providerId = providerId;
    editProvider.textContent = "编辑";
    actions.append(addModel, editProvider);
    head.append(dot, heading, actions);
    card.append(head);

    if (items.length > 0) {
      const list = document.createElement("ul");
      list.className = "model-catalog-list";
      for (const model of items) list.append(buildRow(model));
      card.append(list);
    } else {
      card.append(Object.assign(document.createElement("p"), {
        className: "provider-empty",
        textContent: "该提供商暂无可运行模型；点击「新增模型」添加。",
      }));
    }
    return card;
  }

  function drawCatalog(listing) {
    catalogList.replaceChildren();
    const groups = new Map();
    for (const model of models) {
      if (!groups.has(model.provider)) groups.set(model.provider, []);
      groups.get(model.provider).push(model);
    }
    // 提供商层允许先建空提供商再补模型；仅存在于 models.json 的条目也要显示。
    for (const provider of catalog.providers) {
      if (!groups.has(provider.id)) groups.set(provider.id, []);
    }

    for (const [providerId, items] of groups) {
      catalogList.append(buildProviderCard(providerId, items));
    }

    count.textContent = models.length ? `${models.length} 个模型` : "";
    empty.hidden = groups.size > 0 || Boolean(listing?.catalogError);
    empty.textContent = "当前 Pi 配置没有可用模型。用「新增模型」添加供应商与模型，或打开 models.json 手动配置后重新读取。";
  }

  function resetAfterFailure() {
    levels = [];
    thinking.replaceChildren();
    current.textContent = "";
    currentName.textContent = "模型暂不可用";
    currentProvider.textContent = "—";
    currentContext.textContent = "暂不可用";
    currentTags.replaceChildren();
    defaultLabel.textContent = "暂不可用";
    state.textContent = "配置读取失败";
    state.dataset.state = "error";
    thinkingHint.textContent = "";
    catalogList.replaceChildren();
    count.textContent = "";
    warning.hidden = true;
    warning.textContent = "";
    empty.hidden = false;
    empty.textContent = "模型配置读取失败，修正后重新读取即可恢复列表。";
  }

  /* ------------------------------ 表单 ------------------------------ */

  function fillProviderOptions(selectedId) {
    const ids = [...new Set([...catalog.providers.map((item) => item.id), selectedId].filter(Boolean))];
    providerIdField.replaceChildren(
      ...ids.map((id) => option(id, id)),
      option("__new__", "新建供应商…"),
    );
    providerIdField.value = selectedId && ids.includes(selectedId) ? selectedId : "__new__";
    providerIdWrapper.hidden = providerIdField.value !== "__new__";
  }

  // 协议下拉来自主进程给出的合法清单；已有配置里的自定义协议也保留，避免保存时被清空。
  function fillProtocolOptions() {
    const apis = catalog.options.api ?? [];
    field("providerApi").replaceChildren(
      option("", "不设置，沿用内置默认"),
      ...apis.map((value) => option(value, value)),
    );
    field("api").replaceChildren(
      option("", "继承供应商设置"),
      ...apis.map((value) => option(value, value)),
    );
    providerField("api").replaceChildren(
      option("", "不设置，沿用内置默认"),
      ...apis.map((value) => option(value, value)),
    );
  }

  function keepOption(select, value) {
    if (!value) return;
    if ([...select.options].some((item) => item.value === value)) return;
    select.append(option(value, value));
  }

  function fillProviderFields(providerId) {
    const configured = catalog.providers.find((item) => item.id === providerId);
    field("providerName").value = configured?.name ?? "";
    field("providerBaseUrl").value = configured?.baseUrl ?? "";
    field("providerApi").value = configured?.api ?? "";
  }

  function fillThinkingLevels(checked) {
    const all = catalog.options.thinkingLevels.length
      ? catalog.options.thinkingLevels
      : ["off", "minimal", "low", "medium", "high"];
    thinkingLevelsBox.replaceChildren(
      ...all.map((level) => {
        const label = document.createElement("label");
        label.className = "model-level";
        const input = document.createElement("input");
        input.type = "checkbox";
        input.dataset.level = level;
        input.checked = checked.includes(level);
        // 关闭档始终可用，避免出现无法关掉思考的配置。
        if (level === "off") {
          input.checked = true;
          input.disabled = true;
        }
        const text = document.createElement("span");
        text.textContent = LEVEL_LABELS[level] ?? level;
        label.append(input, text);
        return label;
      }),
    );
  }

  function fillExtra(name, value) {
    const textarea = field(name);
    textarea.value = value && Object.keys(value).length ? JSON.stringify(value, null, 2) : "";
  }

  // models.json 里常常只写了 id，缺的字段用运行时实际生效的值补全，避免表单显示成空。
  function mergeSource(runtimeModel, configuredModel) {
    const source = { ...(runtimeModel ?? {}) };
    for (const [key, value] of Object.entries(configuredModel ?? {})) {
      if (value === undefined || value === null) continue;
      if (Array.isArray(value) && !value.length) continue;
      if (typeof value === "object" && !Array.isArray(value) && !Object.keys(value).length) continue;
      source[key] = value;
    }
    return source;
  }

  function openEditor(target) {
    editing = target.modelId ? { providerId: target.providerId, modelId: target.modelId } : null;
    providerEditor.hidden = true;
    editingProvider = "";
    providerEditorStatus.textContent = "";
    editorStatus.textContent = "";
    const configuredProvider = catalog.providers.find((item) => item.id === target.providerId);
    const configuredModel = configuredProvider?.models.find((item) => item.id === target.modelId);
    const runtimeModel = models.find(
      (item) => item.provider === target.providerId && item.id === target.modelId,
    );
    const source = mergeSource(runtimeModel, configuredModel);

    fillProviderOptions(target.providerId);
    fillProviderFields(target.providerId);
    keepOption(field("providerApi"), configuredProvider?.api);
    keepOption(field("api"), source.api);
    field("providerApi").value = configuredProvider?.api ?? "";
    field("providerNewId").value = "";
    field("id").value = source.id ?? "";
    field("name").value = source.name ?? "";
    field("api").value = source.api ?? "";
    field("contextWindow").value = source.contextWindow ?? "";
    field("maxTokens").value = source.maxTokens ?? "";
    const inputs = source.input?.length ? source.input : ["text"];
    field("inputText").checked = inputs.includes("text");
    field("inputImage").checked = inputs.includes("image");
    field("reasoning").checked = source.reasoning === true;
    field("thinkingFormat").value = configuredModel?.thinkingFormat ?? "";
    field("costInput").value = source.cost?.input ?? "";
    field("costOutput").value = source.cost?.output ?? "";
    field("costCacheRead").value = source.cost?.cacheRead ?? "";
    field("costCacheWrite").value = source.cost?.cacheWrite ?? "";

    // 已有映射按映射勾选；只有 reasoning 标记的模型给出常用档位。
    let checked = ["off"];
    if (source.thinkingLevelMap) {
      checked = Object.entries(source.thinkingLevelMap)
        .filter(([, value]) => typeof value === "string")
        .map(([level]) => level);
    } else if (source.reasoning) {
      checked = DEFAULT_REASONING_LEVELS;
    }
    fillThinkingLevels(checked);

    for (const [name, key] of [
      ["extraInputLimits", "inputLimits"],
      ["extraSamplingParams", "samplingParams"],
      ["extraSamplingByLevel", "samplingParamsByThinkingLevel"],
      ["extraPromptCache", "promptCache"],
    ]) {
      fillExtra(name, configuredModel?.extra?.[key]);
    }

    editorTitle.textContent = editing ? "编辑模型" : "新增模型";
    editorHint.textContent = editing
      ? "保存后覆盖 models.json 中的同名条目"
      : "写入 Pi 官方 models.json";
    if (runtimeModel && !configuredModel) {
      editorHint.textContent = "该模型来自 Pi 内置目录，保存后会新增覆盖条目";
    }
    editor.hidden = false;
    editor.scrollIntoView({ block: "nearest" });
    field("id").focus();
  }

  function closeEditor() {
    editor.hidden = true;
    editing = null;
    editorStatus.textContent = "";
  }

  function resetProviderDelete() {
    pendingProviderDelete = "";
    providerDeleteButton.textContent = "删除提供商";
    providerDeleteButton.title = "删除该提供商及其全部模型";
  }

  function closeProviderEditor() {
    providerEditor.hidden = true;
    editingProvider = "";
    providerEditorStatus.textContent = "";
    resetProviderDelete();
  }

  function openProviderEditor(providerId) {
    editingProvider = providerId ?? "";
    const configured = catalog.providers.find((item) => item.id === editingProvider);
    fillProtocolOptions();
    providerEditorTitle.textContent = editingProvider ? "编辑提供商" : "新增提供商";
    providerField("providerId").value = editingProvider;
    providerField("providerId").readOnly = Boolean(editingProvider);
    providerField("name").value = configured?.name ?? "";
    providerField("baseUrl").value = configured?.baseUrl ?? "";
    keepOption(providerField("api"), configured?.api);
    providerField("api").value = configured?.api ?? "";
    providerDeleteButton.hidden = !editingProvider;
    providerEditorStatus.textContent = "";
    resetProviderDelete();
    editor.hidden = true;
    editing = null;
    providerEditor.hidden = false;
    providerEditor.scrollIntoView({ block: "nearest" });
    (editingProvider ? providerField("name") : providerField("providerId")).focus();
  }

  function readNumber(name, label) {
    const raw = field(name).value.trim();
    if (!raw) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new Error(`${label}需要是有效的非负数字。`);
    return value;
  }

  function readExtra(name, label) {
    const raw = field(name).value.trim();
    if (!raw) return undefined;
    let value;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error(`${label} 不是有效的 JSON。`);
    }
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label} 需要是 JSON 对象。`);
    }
    return value;
  }

  function collectInput() {
    const providerId = providerIdField.value === "__new__"
      ? field("providerNewId").value.trim()
      : providerIdField.value;
    if (!providerId) throw new Error("请填写供应商编号。");
    if (!field("id").value.trim()) throw new Error("请填写模型编号。");

    const inputs = [];
    if (field("inputText").checked) inputs.push("text");
    if (field("inputImage").checked) inputs.push("image");
    if (!inputs.length) throw new Error("至少选择一种输入类型。");

    const thinkingLevels = [...thinkingLevelsBox.querySelectorAll('input[data-level]')]
      .filter((input) => input.checked)
      .map((input) => input.dataset.level);

    return {
      providerId,
      provider: {
        name: field("providerName").value.trim(),
        baseUrl: field("providerBaseUrl").value.trim(),
        api: field("providerApi").value,
      },
      original: editing ?? undefined,
      model: {
        id: field("id").value.trim(),
        name: field("name").value.trim(),
        api: field("api").value,
        reasoning: field("reasoning").checked,
        contextWindow: readNumber("contextWindow", "上下文窗口"),
        maxTokens: readNumber("maxTokens", "最大输出"),
        input: inputs,
        cost: {
          input: readNumber("costInput", "输入计费"),
          output: readNumber("costOutput", "输出计费"),
          cacheRead: readNumber("costCacheRead", "缓存读取计费"),
          cacheWrite: readNumber("costCacheWrite", "缓存写入计费"),
        },
        thinkingLevels,
        thinkingFormat: field("thinkingFormat").value,
        extra: {
          inputLimits: readExtra("extraInputLimits", "inputLimits"),
          samplingParams: readExtra("extraSamplingParams", "samplingParams"),
          samplingParamsByThinkingLevel: readExtra("extraSamplingByLevel", "samplingParamsByThinkingLevel"),
          promptCache: readExtra("extraPromptCache", "promptCache"),
        },
      },
    };
  }

  /* ------------------------------ 读取与操作 ------------------------------ */

  async function show() {
    const token = ++sequence;
    loading = true;
    update();
    status.textContent = "正在读取 Pi 模型配置……";
    try {
      const config = await api.readModelConfiguration();
      if (token !== sequence) return;
      modelsPath = config.modelsPath;
      path.textContent = modelsPath;

      // 会话信息、模型目录与可编辑配置互不依赖，并行读取；任一失败各自降级。
      const [sessionResult, listingResult, catalogResult] = await Promise.all([
        api.getSessionInfo().then(
          (value) => ({ info: value }),
          (error) => ({ error }),
        ),
        api.listModels().then(
          (value) => ({ listing: value ?? { models: [] } }),
          (error) => ({ listing: { models: [], catalogError: error.message } }),
        ),
        api.readModelCatalog().then(
          (value) => ({ catalog: value }),
          (error) => ({ catalogError: error.message }),
        ),
      ]);
      if (token !== sequence) return;
      if (sessionResult.error) throw sessionResult.error;
      if (catalogResult.catalog) catalog = catalogResult.catalog;
      // 任一编辑器打开时都不重建协议下拉，避免覆盖用户正在修改的选择。
      if (editor.hidden && providerEditor.hidden) fillProtocolOptions();

      const info = sessionResult.info;
      const listing = listingResult.listing ?? { models: [] };
      models = listing.models ?? [];
      currentModel = { provider: info.provider, modelId: info.modelId };
      defaults = { provider: listing.defaultProvider ?? "", modelId: listing.defaultModel ?? "" };

      drawThinking(info);
      drawCurrent(info, models);
      // 目录读取失败只影响“可用模型”卡片，不推翻已经读到的当前模型。
      const problem = listing.catalogError
        ? `可用模型读取失败：${listing.catalogError}`
        : catalogResult.catalogError
          ? `模型配置文件读取失败：${catalogResult.catalogError}`
          : listing.warning ?? "";
      warning.hidden = !problem;
      warning.textContent = problem;
      drawCatalog(listing);
      status.textContent = "";
      return true;
    } catch (error) {
      if (token !== sequence) return;
      resetAfterFailure();
      status.textContent = `读取失败：${error.message} 可打开配置文件修正后重新读取。`;
    } finally {
      if (token === sequence) {
        loading = false;
        update();
      }
    }
  }

  async function act(operation, message) {
    if (busy || loading) return;
    setPageBusy(true);
    try {
      const result = await operation();
      // 读取失败时不覆盖错误信息，避免把仍存在的配置问题显示成操作成功。
      if (await show()) status.textContent = message(result);
    } catch (error) {
      status.textContent = `操作未完成：${error.message}`;
    } finally {
      await refreshModels();
      setPageBusy(false);
    }
  }

  /* ------------------------------ 事件 ------------------------------ */

  copyButton.addEventListener("click", async () => {
    if (copyButton.disabled || !modelsPath) return;
    try {
      await navigator.clipboard.writeText(modelsPath);
      status.textContent = "配置文件路径已复制。";
    } catch {
      // 剪贴板不可用时选中路径，由使用者手动复制。
      const range = document.createRange();
      range.selectNodeContents(path);
      const selection = window.getSelection();
      if (selection) {
        selection.removeAllRanges();
        selection.addRange(range);
      }
      status.textContent = "无法写入剪贴板，已选中路径，可按 ⌘C 复制。";
    }
  });

  addButton.addEventListener("click", () => {
    const providerId = catalog.providers[0]?.id ?? "";
    openEditor({ providerId, modelId: "" });
  });

  addProviderButton.addEventListener("click", () => openProviderEditor(""));

  enableThinking.addEventListener("click", () =>
    openEditor({ providerId: currentModel.provider, modelId: currentModel.modelId }),
  );

  providerIdField.addEventListener("change", () => {
    const creating = providerIdField.value === "__new__";
    providerIdWrapper.hidden = !creating;
    if (creating) {
      field("providerName").value = "";
      field("providerBaseUrl").value = "";
      field("providerApi").value = "";
      field("providerNewId").value = "";
    } else {
      fillProviderFields(providerIdField.value);
    }
  });

  // 目录行内的操作统一委托，避免每次重绘绑定大量监听器。
  catalogList.addEventListener("click", (event) => {
    const providerButton = event.target.closest("button[data-provider-action]");
    if (providerButton) {
      if (busy) return;
      const providerId = providerButton.dataset.providerId;
      if (providerButton.dataset.providerAction === "add-model") {
        openEditor({ providerId, modelId: "" });
        return;
      }
      if (providerButton.dataset.providerAction === "edit-provider") {
        openProviderEditor(providerId);
        return;
      }
    }

    const button = event.target.closest("button[data-action]");
    const row = event.target.closest(".model-row");
    if (!button || !row || busy) return;
    const providerId = row.dataset.provider;
    const modelId = row.dataset.modelId;
    const action = button.dataset.action;

    if (action === "edit") {
      openEditor({ providerId, modelId });
      return;
    }

    if (action === "default") {
      void act(
        () => api.setDefaultModel(providerId, modelId),
        (result) => `已将 ${result?.provider ?? providerId}/${result?.modelId ?? modelId} 设为新对话默认。`,
      );
      return;
    }

    // 删除是破坏性操作，要求在同一行二次确认后再提交。
    const key = `${providerId}::${modelId}`;
    if (pendingDelete !== key) {
      pendingDelete = key;
      button.textContent = "确认删除";
      setTimeout(() => {
        if (pendingDelete !== key) return;
        pendingDelete = "";
        button.textContent = "删除";
      }, 4000);
      return;
    }
    pendingDelete = "";
    button.textContent = "删除";
    void act(
      () => api.deleteModel(providerId, modelId),
      () => `已从 models.json 删除 ${providerId}/${modelId}。`,
    );
  });

  // 勾选“支持思考强度”时补上常用档位，避免保存成只有关闭一档的空能力。
  field("reasoning").addEventListener("change", () => {
    if (!field("reasoning").checked) return;
    const inputs = [...thinkingLevelsBox.querySelectorAll("input[data-level]")];
    if (inputs.filter((input) => input.checked).length > 1) return;
    for (const input of inputs) input.checked = DEFAULT_REASONING_LEVELS.includes(input.dataset.level);
  });

  providerForm.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || loading) return;
    const providerId = providerField("providerId").value.trim();
    if (!providerId) {
      providerEditorStatus.textContent = "请填写供应商编号。";
      return;
    }
    providerEditorStatus.textContent = "正在保存……";
    setPageBusy(true);
    api
      .saveProvider({
        providerId,
        provider: {
          name: providerField("name").value.trim(),
          baseUrl: providerField("baseUrl").value.trim(),
          api: providerField("api").value,
        },
      })
      .then(async (result) => {
        closeProviderEditor();
        if (await show()) {
          status.textContent = `已${result?.action === "updated" ? "更新" : "新增"}提供商 ${result?.providerId ?? providerId}。${
            result?.warning ? ` ${result.warning}` : ""
          }`;
        }
      })
      .catch((error) => {
        providerEditorStatus.textContent = `保存失败：${error.message}`;
      })
      .finally(async () => {
        await refreshModels();
        setPageBusy(false);
      });
  });

  providerForm.querySelector("[data-provider-cancel]").addEventListener("click", closeProviderEditor);

  providerDeleteButton.addEventListener("click", () => {
    if (busy || loading || !editingProvider) return;
    if (pendingProviderDelete !== editingProvider) {
      pendingProviderDelete = editingProvider;
      providerDeleteButton.textContent = "确认删除提供商";
      providerEditorStatus.textContent = "再次点击确认删除该提供商及其全部模型。";
      setTimeout(() => {
        if (pendingProviderDelete !== editingProvider) return;
        resetProviderDelete();
        providerEditorStatus.textContent = "";
      }, 4000);
      return;
    }
    const providerId = editingProvider;
    resetProviderDelete();
    providerEditorStatus.textContent = "正在删除……";
    setPageBusy(true);
    api
      .deleteProvider(providerId)
      .then(async (result) => {
        closeProviderEditor();
        if (await show()) {
          const models = result?.modelCount ? `，同时移除 ${result.modelCount} 个模型` : "";
          status.textContent = `已删除提供商 ${result?.providerId ?? providerId}${models}。${
            result?.warning ? ` ${result.warning}` : ""
          }`;
        }
      })
      .catch((error) => {
        providerEditorStatus.textContent = `删除失败：${error.message}`;
      })
      .finally(async () => {
        await refreshModels();
        setPageBusy(false);
      });
  });

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    if (busy || loading) return;
    let input;
    try {
      input = collectInput();
    } catch (error) {
      editorStatus.textContent = error.message;
      return;
    }
    editorStatus.textContent = "正在保存……";
    setPageBusy(true);
    api
      .saveModel(input)
      .then(async (result) => {
        closeEditor();
        if (await show()) {
          status.textContent = `已${result?.action === "updated" ? "更新" : "新增"}模型 ${result?.providerId}/${result?.modelId}。${
            result?.warning ? ` ${result.warning}` : ""
          }`;
        }
      })
      .catch((error) => {
        editorStatus.textContent = `保存失败：${error.message}`;
      })
      .finally(async () => {
        await refreshModels();
        setPageBusy(false);
      });
  });

  form.querySelector("[data-cancel-edit]").addEventListener("click", closeEditor);

  panel.querySelector("[data-open-models]").addEventListener("click", () =>
    act(
      () => api.openModelsConfiguration(),
      () => "已打开 models.json；编辑保存后点击“重新读取模型”。",
    ),
  );
  panel.querySelector("[data-reload-models]").addEventListener("click", () =>
    act(
      () => api.reloadModels(),
      (result) => {
        const amount = result?.models?.length ?? 0;
        return `模型配置已重新读取，共 ${amount} 个可用模型。Provider 扩展修改后请在聊天中执行 /reload。`;
      },
    ),
  );
  defaultButton.addEventListener("click", () =>
    act(
      () => api.setDefaultModel(),
      // 默认值写入失败时后端会抛出，这里只使用返回值确认实际保存的对象。
      (result) => {
        const target = result?.provider ? `${result.provider}/${result.modelId}` : "当前模型";
        return `已将 ${target} 设为新对话默认；已有对话保持各自选择。`;
      },
    ),
  );
  thinking.addEventListener("change", () =>
    act(
      () => api.setThinkingLevel(thinking.value),
      () => "当前对话的思考强度已更新，并按模型记住该选择。",
    ),
  );

  return {
    show,
    setBusy(value) {
      busy = value;
      update();
    },
    hide() {
      ++sequence;
      loading = false;
      pendingDelete = "";
    },
  };
}
