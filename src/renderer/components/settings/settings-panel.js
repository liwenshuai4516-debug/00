import { createModelSettingsPanel } from "../model-settings-panel.js";
import { createThemeSettings } from "../theme/theme-settings.js";
import { createPiResourcesPanel } from "./pi-resources.js";
import { createPromptSettings } from "./prompt-settings.js";

export function createSettingsPanel(
  dialog,
  openButton,
  api,
  setPageBusy,
  refreshProfiles,
  insertText,
) {
  const resources = createPiResourcesPanel(dialog, api, setPageBusy, insertText);
  const prompts = createPromptSettings(dialog, api, setPageBusy);
  const models = createModelSettingsPanel(
    dialog,
    openButton,
    api,
    setPageBusy,
    refreshProfiles,
    () => !prompts.isSaving() && !resources.isSaving(),
  );
  const appearance = createThemeSettings(
    dialog.querySelector("[data-theme-panel]"),
  );
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const panels = [...dialog.querySelectorAll('[role="tabpanel"]')];
  const heading = dialog.querySelector("#model-settings-title");
  let busy = true;

  function selectTab(tab) {
    if (busy) return;
    const showModels = tab.dataset.settingsTab === "model";
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    for (const panel of panels)
      panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    heading.textContent = tab.textContent;
    for (const element of dialog.querySelectorAll(
      ".model-manager-feedback, [data-default-label], [data-refresh-official]",
    ))
      element.hidden = !showModels;
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

  // 设置窗口保留上次分类，再次打开时刷新当前对话快照。
  openButton.addEventListener("click", () => {
    if (dialog.open && dialog.querySelector("#settings-prompt-tab").getAttribute("aria-selected") === "true") {
      prompts.show();
    }
    if (dialog.open && dialog.querySelector("#settings-resources-tab").getAttribute("aria-selected") === "true") void resources.show();
  });

  return {
    setBusy(value) {
      busy = value;
      models.setBusy(value);
      appearance.setBusy(value);
      prompts.setBusy(value);
      resources.setBusy(value);

      for (const tab of tabs) tab.disabled = value;
      dialog.querySelector("#archive-session-search").disabled = value;
    },
  };
}
