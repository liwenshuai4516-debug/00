// 只提交配置编号；相同模型 ID 的不同地址和凭据仍是独立配置。
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
    select.title = text;
  }

  async function refresh(prefix = "") {
    ready = false;
    select.disabled = true;
    showPlaceholder("正在读取模型……");
    status.hidden = false;
    status.textContent = `${prefix}正在读取当前模型……`;
    element.setAttribute("aria-busy", "true");

    try {
      const info = await api.listModelProfiles();
      select.replaceChildren();

      for (const model of info.profiles) {
        const option = document.createElement("option");
        option.value = model.id;
        option.textContent = model.name;
        select.append(option);
      }

      select.value = info.currentProfileId;
      if (select.selectedIndex < 0) {
        throw new Error("当前模型配置不在清单中，请打开“模型与配置”检查。");
      }

      currentId = info.currentProfileId;
      ready = true;
      retryButton.hidden = true;

      // 正常状态由选择框展示；完整编号保留在悬浮提示中。
      const current = info.profiles.find((item) => item.id === currentId);
      select.title = `${current.name} · ${current.provider}/${info.currentModelId ?? current.modelId}`;
      status.textContent = prefix;
      status.hidden = !prefix;
    } catch (error) {
      showPlaceholder("模型暂不可用");
      retryButton.hidden = false;

      // 失败提示和重试入口必须继续可见。
      status.hidden = false;
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
    status.hidden = false;
    status.textContent = "正在切换模型……";
    let prefix = "";

    try {
      await api.switchModelProfile(modelId);
    } catch (error) {
      prefix = `切换未完成：${error.message} `;
    } finally {
      // SDK 报错也可能已改变模型，仍然重新读取实际选择。
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