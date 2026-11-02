import { createModelSettingsPanel } from "../model-settings-panel.js";
import { createThemeSettings } from "../theme/theme-settings.js";

export function createSettingsPanel(dialog, openButton, api, setPageBusy, refreshProfiles) {
  const models = createModelSettingsPanel(dialog, openButton, api, setPageBusy, refreshProfiles);
  const appearance = createThemeSettings(dialog.querySelector("[data-theme-panel]"));
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
    for (const panel of panels) panel.hidden = panel.id !== tab.getAttribute("aria-controls");
    heading.textContent = tab.textContent;
    for (const element of dialog.querySelectorAll(".model-manager-feedback, [data-default-label], [data-refresh-official]")) element.hidden = !showModels;
    const descriptions = { model: "model-settings-intro", theme: "theme-settings-intro", archive: "archive-settings-intro" };
    dialog.setAttribute("aria-describedby", descriptions[tab.dataset.settingsTab]);
  }
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => selectTab(tab));
    tab.addEventListener("keydown", event => {
      if (busy || event.isComposing) return;
      const next = event.key === "ArrowDown" ? (index + 1) % tabs.length
        : event.key === "ArrowUp" ? (index + tabs.length - 1) % tabs.length
        : event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : null;
      if (next === null) return;
      event.preventDefault(); selectTab(tabs[next]); tabs[next].focus();
    });
  });

  return { setBusy(value) {
    busy = value;
    models.setBusy(value); appearance.setBusy(value);
    for (const tab of tabs) tab.disabled = value;
    dialog.querySelector("#archive-session-search").disabled = value;
  } };
}
