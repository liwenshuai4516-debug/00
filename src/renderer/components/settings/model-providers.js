export function createModelProviders(panel, api, setPageBusy, refreshModels) {
  const path = panel.querySelector("[data-models-path]");
  const current = panel.querySelector("[data-current-model]");
  const status = panel.querySelector("[data-provider-status]");
  const thinking = panel.querySelector("select");
  const buttons = [...panel.querySelectorAll("button")];
  let busy = true;
  let loading = false;
  let sequence = 0;
  let levels = [];

  function update() {
    buttons.forEach(button => { button.disabled = busy || loading; });
    thinking.disabled = busy || loading || levels.length === 0;
  }
  async function show() {
    const token = ++sequence;
    loading = true;
    update();
    status.textContent = "正在读取 Pi 模型配置……";
    try {
      const config = await api.readModelConfiguration();
      if (token !== sequence) return;
      path.textContent = config.modelsPath;
      const info = await api.getSessionInfo();
      if (token !== sequence) return;
      current.textContent = `${info.provider}/${info.modelId}`;
      levels = info.thinkingLevels ?? ["off"];
      thinking.replaceChildren();
      for (const level of levels) {
        const option = document.createElement("option");
        option.value = level;
        option.textContent = ({ off: "关闭", minimal: "最低", low: "低", medium: "中", high: "高", xhigh: "最高", max: "最大" })[level] ?? level;
        thinking.append(option);
      }
      thinking.value = info.thinkingLevel ?? "off";
      status.textContent = "";
      return true;
    } catch (error) {
      if (token !== sequence) return;
      levels = [];
      current.textContent = "暂不可用";
      status.textContent = `读取失败：${error.message} 可打开配置文件修正后重新读取。`;
    } finally {
      if (token === sequence) { loading = false; update(); }
    }
  }
  async function act(operation, message) {
    if (busy || loading) return;
    setPageBusy(true);
    try {
      await operation();
      if (await show()) status.textContent = message;
    } catch (error) {
      status.textContent = `操作未完成：${error.message}`;
    } finally {
      await refreshModels();
      setPageBusy(false);
    }
  }
  panel.querySelector("[data-open-models]").addEventListener("click", () =>
    act(() => api.openModelsConfiguration(), "已打开 models.json；编辑保存后点击“重新读取模型”。"));
  panel.querySelector("[data-reload-models]").addEventListener("click", () =>
    act(() => api.reloadModels(), "模型配置已重新读取。Provider 扩展修改后请在聊天中执行 /reload。"));
  panel.querySelector("[data-default-model]").addEventListener("click", () =>
    act(() => api.setDefaultModel(), "当前模型已设为新对话默认，已有对话保持各自选择。"));
  thinking.addEventListener("change", () =>
    act(() => api.setThinkingLevel(thinking.value), "当前对话的思考强度已更新。"));
  return {
    show,
    setBusy(value) { busy = value; update(); },
    hide() { ++sequence; loading = false; },
  };
}
