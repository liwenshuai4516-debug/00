import { getThemePreference, selectTheme, themes } from "../../theme/theme-preference.js";

export function createThemeSettings(root) {
  const choices = root.querySelector("[data-theme-choices]");
  const status = root.querySelector("[data-theme-status]");
  const inputs = [];
  function render(changed = false) {
    const preference = getThemePreference();
    for (const input of inputs) input.checked = input.value === preference.id;
    const name = themes.find(theme => theme.id === preference.id).name;
    status.textContent = preference.saved
      ? `${changed ? "已切换为" : "当前主题："}${name}，下次启动继续使用。`
      : `当前使用${name}，本机偏好暂时无法读写；下次启动可能恢复为之前的主题。`;
  }
  for (const theme of themes) {
    const label = document.createElement("label");
    label.className = "theme-choice";
    const input = document.createElement("input");
    input.type = "radio"; input.name = "appearance-theme"; input.value = theme.id;
    const preview = document.createElement("span");
    preview.className = `theme-preview theme-preview-${theme.id}`;
    preview.setAttribute("aria-hidden", "true");
    for (let i = 0; i < 3; i++) preview.append(document.createElement("span"));
    const name = document.createElement("strong");
    name.textContent = theme.name;
    const hint = document.createElement("small");
    hint.textContent = theme.id === "dark" ? "深灰背景与中性配色" : "浅粉背景与玫粉强调色";
    label.append(input, preview, name, hint);
    input.addEventListener("change", () => {
      if (!input.disabled && input.checked) { selectTheme(input.value); render(true); }
    });
    choices.append(label); inputs.push(input);
  }
  render();
  return { setBusy(value) { for (const input of inputs) input.disabled = value; } };
}
