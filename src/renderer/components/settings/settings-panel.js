import { createModelProviders } from "./model-providers.js";
import { createThemeSettings } from "../theme/theme-settings.js";
import { createPiResourcesPanel } from "./pi-resources.js";
import { createPromptSettings } from "./prompt-settings.js";

export function createSettingsPanel(
  dialog,
  openButton,
  api,
  setPageBusy,
  refreshModels,
  insertText,
) {
  const resources = createPiResourcesPanel(dialog, api, setPageBusy, insertText);
  const prompts = createPromptSettings(dialog, api, setPageBusy);
  const models = createModelProviders(dialog.querySelector("#settings-model-panel"), api, setPageBusy, refreshModels);
  const appearance = createThemeSettings(
    dialog.querySelector("[data-theme-panel]"),
  );
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const panels = [...dialog.querySelectorAll('[role="tabpanel"]')];
  const heading = dialog.querySelector("#model-settings-title");
  let busy = true;

  function selectTab(tab) {
    if (busy) return;
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    for (const panel of panels)
      panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    heading.textContent = tab.textContent;
    const descriptions = {
      model: "model-settings-intro",
      theme: "theme-settings-intro",
      archive: "archive-settings-intro",
      prompt: "prompt-settings-intro",
      resources: "pi-resources-intro",
    };

    dialog.setAttribute(
      "aria-describedby",
      descriptions[tab.dataset.settingsTab],
    );
    if (tab.dataset.settingsTab === "model") void models.show();
    else models.hide();
    if (tab.dataset.settingsTab === "prompt") prompts.show();
    if (tab.dataset.settingsTab === "resources") void resources.show();
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", (event) => {
      if (busy || event.isComposing) return;
      const next =
        event.key === "ArrowDown"
          ? (index + 1) % tabs.length
          : event.key === "ArrowUp"
            ? (index + tabs.length - 1) % tabs.length
            : event.key === "Home"
              ? 0
              : event.key === "End"
                ? tabs.length - 1
                : null;
      if (next === null) return;
      event.preventDefault();
      selectTab(tabs[next]);
      tabs[next].focus();
    });
  });

  // 设置弹窗由设置容器管理；模型配置不再控制其他分类的生命周期。
  function close() {
    if (busy || prompts.isSaving() || resources.isSaving()) return;
    models.hide();
    dialog.close();
    openButton.focus();
  }
  openButton.addEventListener("click", () => {
    if (busy) return;
    dialog.showModal();
    selectTab(tabs.find(tab => tab.getAttribute("aria-selected") === "true"));
  });
  dialog.querySelector("[data-close]").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });

  return {
    setBusy(value) {
      busy = value;
      dialog.setAttribute("aria-busy", String(value));
      openButton.disabled = value;
      dialog.querySelector("[data-close]").disabled = value;
      models.setBusy(value);
      appearance.setBusy(value);
      prompts.setBusy(value);
      resources.setBusy(value);

      for (const tab of tabs) tab.disabled = value;
      dialog.querySelector("#archive-session-search").disabled = value;
    },
  };
}
