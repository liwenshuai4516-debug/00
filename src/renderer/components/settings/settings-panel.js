import { createModelSettingsPanel } from "../model-settings-panel.js";
import { createThemeSettings } from "../theme/theme-settings.js";

export function createSettingsPanel(dialog, openButton, api, setPageBusy, refreshProfiles) {
  const models = createModelSettingsPanel(dialog, openButton, api, setPageBusy, refreshProfiles);
  const appearance = createThemeSettings(dialog.querySelector("[data-theme-panel]"));
  const tabs = [...dialog.querySelectorAll('[role="tab"]')];
  const modelPanel = dialog.querySelector(".settings-layout");
  const themePanel = dialog.querySelector("[data-theme-panel]");
  let busy = true;

  function selectTab(tab) {
    if (busy) return;
    const showModels = tab.dataset.settingsTab === "model";
    for (const item of tabs) {
      item.setAttribute("aria-selected", String(item === tab));
      item.tabIndex = item === tab ? 0 : -1;
    }
    modelPanel.hidden = !showModels;
    themePanel.hidden = showModels;
    for (const element of dialog.querySelectorAll(".model-manager-feedback, [data-default-label], [data-refresh-official]")) element.hidden = !showModels;
    dialog.setAttribute("aria-describedby", showModels ? "model-settings-intro" : "theme-settings-intro");
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      if (busy || event.isComposing) return;
      const next = event.key === "ArrowRight" ? (index + 1) % tabs.length
        : event.key === "ArrowLeft" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); selectTab(tabs[next]); tabs[next].focus();
    });
  });

  return { setBusy(value) {
    busy = value;
    models.setBusy(value); appearance.setBusy(value);
    for (const tab of tabs) tab.disabled = value;
  } };
}
