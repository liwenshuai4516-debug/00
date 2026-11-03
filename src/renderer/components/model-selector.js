// 使用供应商和模型的原生编号，避免不同供应商的同名模型混淆。
export function createModelSelector(element, api, setPageBusy, refreshInfo) {
  const select = element.querySelector("select");
  const retryButton = element.querySelector("button");
  const status = element.querySelector('[role="status"]');
  let busy = true;
  let ready = false;
  let currentId = "";
  let sequence = 0;
  const key = model => JSON.stringify([model.provider, model.id]);

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
    const token = ++sequence;
    ready = false;
    select.disabled = true;
    showPlaceholder("正在读取模型……");
    status.hidden = false;
    status.textContent = `${prefix}正在读取当前模型……`;
    element.setAttribute("aria-busy", "true");
    try {
      const info = await api.listModels();
      if (token !== sequence) return;
      select.replaceChildren();
      const groups = new Map();
      for (const model of info.models) {
        if (!groups.has(model.provider)) {
          const group = document.createElement("optgroup");
          group.label = model.provider;
          select.append(group);
          groups.set(model.provider, group);
        }
        const option = document.createElement("option");
        option.value = key(model);
        option.textContent = model.name;
        groups.get(model.provider).append(option);
      }
      currentId = key({ provider: info.provider, id: info.modelId });
      select.value = currentId;
      if (select.selectedIndex < 0) {
        // 当前认证或配置被移除时仍允许选择其余模型，而不是锁住选择器。
        const option = document.createElement("option");
        option.value = "";
        option.textContent = "当前模型不可用，请重新选择";
        option.disabled = true;
        select.prepend(option);
        select.value = "";
      }
      ready = info.models.length > 0;
      retryButton.hidden = ready;
      select.title = `${info.provider}/${info.modelId}`;
      status.textContent = prefix || info.warning || (ready ? "" : "没有可用模型，请在设置中配置供应商认证。");
      status.hidden = !status.textContent;
    } catch (error) {
      if (token !== sequence) return;
      showPlaceholder("模型暂不可用");
      retryButton.hidden = false;
      status.hidden = false;
      status.textContent = `${prefix}模型读取失败：${error.message}`;
    } finally {
      if (token === sequence) {
        element.setAttribute("aria-busy", "false");
        setBusy(busy);
      }
    }
  }

  select.addEventListener("change", async () => {
    if (select.disabled || !select.value || select.value === currentId) return;
    const [provider, modelId] = JSON.parse(select.value);
    setPageBusy(true);
    status.hidden = false;
    status.textContent = "正在切换模型……";
    let prefix = "";
    try {
      await api.switchModel(modelId, provider);
    } catch (error) {
      prefix = `切换未完成：${error.message} `;
    } finally {
      // SDK 报错也可能已改变选择，必须重新读取实际状态。
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
