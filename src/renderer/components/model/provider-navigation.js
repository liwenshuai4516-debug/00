// 供应商和模型卡片只选择编辑对象，不保存配置或切换当前对话。
export function createProviderNavigation(dialog, onProvider, onProfile) {
  const customList = dialog.querySelector("[data-custom-providers]");
  const builtinList = dialog.querySelector("[data-builtin-providers]");
  const cards = dialog.querySelector("[data-model-cards]");
  let busy = true;

  function button(root, label, detail, selected, action) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = root === cards ? "saved-model-item" : "model-provider-item";
    element.disabled = busy;
    element.setAttribute("aria-current", String(selected));
    const name = document.createElement("span");
    name.textContent = label;
    const hint = document.createElement("small");
    hint.textContent = detail;
    element.append(name, hint);
    element.addEventListener("click", () => { if (!element.disabled) action(); });
    root.append(element);
  }

  return {
    setBusy(value) {
      busy = value;
      for (const element of dialog.querySelectorAll(".model-provider-item, .saved-model-item")) element.disabled = value;
    },
    render(data, kind, provider, selectedId) {
      customList.replaceChildren(); builtinList.replaceChildren(); cards.replaceChildren();
      const customProviders = [...new Set(data.profiles.filter(item => item.kind === "custom").map(item => item.provider))];
      dialog.querySelector("[data-custom-count]").textContent = `(${customProviders.length})`;
      dialog.querySelector("[data-builtin-count]").textContent = `(${data.providers.length})`;
      for (const id of customProviders) {
        const count = data.profiles.filter(item => item.kind === "custom" && item.provider === id).length;
        button(customList, id, `${count} 个模型`, kind === "custom" && provider === id, () => onProvider("custom", id));
      }
      if (!customProviders.length) {
        const empty = document.createElement("small");
        empty.className = "model-provider-empty";
        empty.textContent = "尚未添加服务商";
        customList.append(empty);
      }
      for (const item of data.providers) {
        button(builtinList, item.name, "", kind === "builtin" && provider === item.id, () => onProvider("builtin", item.id));
      }
      for (const item of data.profiles.filter(item => item.kind === kind && item.provider === provider)) {
        button(cards, `${item.name} · ${item.modelId}`, item.id === data.defaultProfileId ? "默认" : "", item.id === selectedId, () => onProfile(item.id));
      }
      const defaultProfile = data.profiles.find(item => item.id === data.defaultProfileId);
      dialog.querySelector("[data-default-label]").textContent = defaultProfile ? `★ ${defaultProfile.name}` : "";
    },
  };
}
