const storageKey = "agent-client:theme";
export const themes = [
  { id: "dark", name: "默认深色" },
  { id: "sakura", name: "樱粉" },
];

let currentTheme = "dark";
let preferenceSaved = true;
try {
  const saved = localStorage.getItem(storageKey);
  if (themes.some(theme => theme.id === saved)) currentTheme = saved;
} catch {
  preferenceSaved = false;
}
// 在 head 中阻塞首帧执行；主题只改变颜色，不重建聊天或配置节点。
document.documentElement.dataset.theme = currentTheme;

export function getThemePreference() {
  return { id: currentTheme, saved: preferenceSaved };
}

export function selectTheme(id) {
  if (!themes.some(theme => theme.id === id)) throw new Error("不支持的主题。");
  currentTheme = id;
  document.documentElement.dataset.theme = id;
  try {
    localStorage.setItem(storageKey, id);
    preferenceSaved = true;
  } catch {
    preferenceSaved = false;
  }
  return getThemePreference();
}
