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

// 设置页只展示已有接口返回的字段：配置路径、当前会话信息与可用模型目录。
export function createModelProviders(panel, api, setPageBusy, refreshModels) {
  const path = panel.querySelector("[data-models-path]");
  const current = panel.querySelector("[data-current-model]");
  const currentName = panel.querySelector("[data-current-model-name]");
  const currentProvider = panel.querySelector("[data-current-provider]");
  const currentContext = panel.querySelector("[data-current-context]");
  const state = panel.querySelector("[data-model-state]");
  const count = panel.querySelector("[data-model-count]");
  const catalog = panel.querySelector("[data-model-catalog]");
  const empty = panel.querySelector("[data-models-empty]");
  const warning = panel.querySelector("[data-models-warning]");
  const status = panel.querySelector("[data-provider-status]");
  const thinking = panel.querySelector("#model-thinking-level");
  const thinkingHint = panel.querySelector("[data-thinking-hint]");
  const copyButton = panel.querySelector("[data-copy-models-path]");
  const buttons = [...panel.querySelectorAll("button")];
  let busy = true;
  let loading = false;
  let sequence = 0;
  let levels = [];
  let modelsPath = "";

  function update() {
    const disabled = busy || loading;
    for (const button of buttons) button.disabled = disabled;
    copyButton.disabled = disabled || !modelsPath;
    thinking.disabled = disabled || levels.length === 0;
  }

  function drawThinking(info) {
    levels = info.thinkingLevels ?? ["off"];
    thinking.replaceChildren();
    for (const level of levels) {
      const option = document.createElement("option");
      option.value = level;
      option.textContent = LEVEL_LABELS[level] ?? level;
      thinking.append(option);
    }
    thinking.value = info.thinkingLevel ?? "off";
    thinkingHint.textContent =
      levels.length > 1
        ? "只影响当前对话；切换对话后各自保留。"
        : "当前模型没有可调整的思考强度。";
  }

  // 目录按供应商分组；当前模型只做标记，不在页面上切换（切换入口仍在输入框右下角）。
  function drawCatalog(models, info) {
    catalog.replaceChildren();
    const groups = new Map();
    for (const model of models) {
      if (!groups.has(model.provider)) groups.set(model.provider, []);
      groups.get(model.provider).push(model);
    }
    for (const [provider, items] of groups) {
      const group = document.createElement("section");
      group.className = "model-catalog-group";
      const heading = document.createElement("h4");
      heading.textContent = provider;
      const amount = document.createElement("span");
      amount.textContent = `${items.length} 个`;
      heading.append(amount);
      const list = document.createElement("ul");
      list.className = "model-catalog-list";
      for (const model of items) {
        const item = document.createElement("li");
        item.className = "model-catalog-item";
        const name = document.createElement("span");
        name.className = "model-catalog-name";
        name.textContent = model.name || model.id;
        item.append(name);
        // 名称与编号相同时不重复展示。
        if (model.id && model.id !== model.name) {
          const id = document.createElement("code");
          id.className = "model-catalog-id";
          id.textContent = model.id;
          item.append(id);
        }
        if (model.provider === info.provider && model.id === info.modelId) {
          item.classList.add("is-current");
          item.setAttribute("aria-current", "true");
          const tag = document.createElement("span");
          tag.className = "model-catalog-tag";
          tag.textContent = "当前";
          item.append(tag);
        }
        list.append(item);
      }
      group.append(heading, list);
      catalog.append(group);
    }
    // 供应商数量由分组标题体现，徽标只提示规模，避免窄窗挤压标题。
    count.textContent = models.length ? `${models.length} 个模型` : "";
    empty.hidden = models.length > 0;
    empty.textContent = "当前 Pi 配置没有可用模型。可在下方打开 models.json 添加供应商，或放入 Provider 扩展后重新读取。";
  }

  function drawState(models, info) {
    const known = models.some(
      model => model.provider === info.provider && model.id === info.modelId,
    );
    const text = !models.length
      ? "无可用模型"
      : known
        ? "已就绪"
        : "当前模型不在目录中";
    state.textContent = text;
    state.dataset.state = known ? "ok" : "warn";
  }

  function resetAfterFailure() {
    levels = [];
    thinking.replaceChildren();
    current.textContent = "";
    currentName.textContent = "模型暂不可用";
    currentProvider.textContent = "—";
    currentContext.textContent = "暂不可用";
    state.textContent = "配置读取失败";
    state.dataset.state = "error";
    thinkingHint.textContent = "";
    catalog.replaceChildren();
    count.textContent = "";
    warning.hidden = true;
    warning.textContent = "";
    empty.hidden = false;
    empty.textContent = "模型配置读取失败，修正后重新读取即可恢复列表。";
  }

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

      // 会话信息与模型目录互不依赖，并行读取；任一失败各自降级。
      const [sessionResult, catalogResult] = await Promise.all([
        api.getSessionInfo().then(
          value => ({ info: value }),
          error => ({ error }),
        ),
        api.listModels().then(
          value => ({ catalog: value ?? { models: [] } }),
          error => ({ catalog: { models: [], catalogError: error.message } }),
        ),
      ]);
      if (token !== sequence) return;
      if (sessionResult.error) throw sessionResult.error;
      const info = sessionResult.info;
      const listing = catalogResult.catalog ?? { models: [] };

      current.textContent = `${info.provider}/${info.modelId}`;
      currentProvider.textContent = info.provider || "未选择";
      currentContext.textContent = formatContextUsage(info.contextUsage).replace(
        /^上下文估算：/,
        "",
      );
      drawThinking(info);

      const models = listing.models ?? [];
      const matched = models.find(
        model => model.provider === info.provider && model.id === info.modelId,
      );
      currentName.textContent = matched?.name || info.modelId || "未选择模型";
      // 目录读取失败只影响“可用模型”卡片，不推翻已经读到的当前模型。
      if (listing.catalogError) {
        warning.hidden = false;
        warning.textContent = `可用模型读取失败：${listing.catalogError}`;
      } else if (listing.warning) {
        warning.hidden = false;
        warning.textContent = listing.warning;
      } else {
        warning.hidden = true;
        warning.textContent = "";
      }
      drawCatalog(models, info);
      drawState(models, info);
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

  panel.querySelector("[data-open-models]").addEventListener("click", () =>
    act(
      () => api.openModelsConfiguration(),
      () => "已打开 models.json；编辑保存后点击“重新读取模型”。",
    ),
  );
  panel.querySelector("[data-reload-models]").addEventListener("click", () =>
    act(
      () => api.reloadModels(),
      result => {
        const amount = result?.models?.length ?? 0;
        return `模型配置已重新读取，共 ${amount} 个可用模型。Provider 扩展修改后请在聊天中执行 /reload。`;
      },
    ),
  );
  panel.querySelector("[data-default-model]").addEventListener("click", () =>
    act(
      () => api.setDefaultModel(),
      // 默认值写入失败时后端会抛出，这里只使用返回值确认实际保存的对象。
      result => {
        const target = result?.provider
          ? `${result.provider}/${result.modelId}`
          : current.textContent || "当前模型";
        return `已将 ${target} 设为新对话默认；已有对话保持各自选择。`;
      },
    ),
  );
  thinking.addEventListener("change", () =>
    act(
      () => api.setThinkingLevel(thinking.value),
      () => "当前对话的思考强度已更新。",
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
    },
  };
}
