// 只提交模型编号，模型目录和当前选择始终以主进程为准。
export function createModelSelector(element, api, setPageBusy, refreshInfo) {
  const select = element.querySelector("select");
  const retryButton = element.querySelector("button");
  const status = element.querySelector('[role="status"]');
  let busy = true;
  let ready = false;
  let currentId = "";

  function setBusy(value) {
    busy = value;
    select.disabled = busy || !ready;
    retryButton.disabled = busy;
  }

  function showPlaceholder(text) {
    const option = document.createElement("option");
    option.value = "";
    option.textContent = text;
    select.replaceChildren(option);
  }

  // 读取失败在控件旁提示，不清空聊天、输入或文件草稿。
  async function refresh(prefix = "") {
    ready = false;
    select.disabled = true;
    showPlaceholder("正在读取模型……");
    status.textContent = `${prefix}正在读取当前模型……`;
    element.setAttribute("aria-busy", "true");

    try {
      const info = await api.listModels();
      select.replaceChildren();

      for (const model of info.models) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name;
        select.append(option);
      }

      select.value = info.modelId;
      if (select.selectedIndex < 0) {
        throw new Error("当前模型不在目录中，请重新读取。");
      }

      currentId = info.modelId;
      ready = true;
      retryButton.hidden = true;
      status.textContent =
        `${prefix}当前模型：${info.provider}/${info.modelId}。`;
    } catch (error) {
      showPlaceholder("模型暂不可用");
      retryButton.hidden = false;
      status.textContent = `${prefix}模型读取失败：${error.message}`;
    } finally {
      element.setAttribute("aria-busy", "false");
      setBusy(busy);
    }
  }

  select.addEventListener("change", async () => {
    if (select.disabled || select.value === currentId) return;

    const modelId = select.value;
    setPageBusy(true);
    status.textContent = "正在切换模型……";
    let prefix = "";

    try {
      await api.switchModel(modelId);
    } catch (error) {
      prefix = `切换未完成：${error.message} `;
    } finally {
      // SDK 报错也可能已改变模型，不能直接恢复旧选项。
      await refresh(prefix);
      await refreshInfo();
      setPageBusy(false);
      (ready ? select : retryButton).focus();
    }
  });

  retryButton.addEventListener("click", async () => {
    if (retryButton.disabled) return;

    setPageBusy(true);
    await refresh();
    setPageBusy(false);
    (ready ? select : retryButton).focus();
  });

  return { refresh, setBusy };
}