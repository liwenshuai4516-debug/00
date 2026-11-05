// 代码工作视图偏好：只影响页面是否请求并展示本轮改动，不改变 Pi 的发送与文件写入。
const STORAGE_KEY = "agent-client:code-work-view";
const CHANGE_EVENT = "code-work-view-changed";

export function isCodeWorkViewEnabled() {
  try {
    const saved = window.localStorage.getItem(STORAGE_KEY);
    return saved === null ? true : saved === "on";
  } catch {
    return true;
  }
}

export function setCodeWorkViewEnabled(enabled) {
  const next = enabled === true;
  try {
    window.localStorage.setItem(STORAGE_KEY, next ? "on" : "off");
  } catch {
    // 隐私模式等写入失败时仍按本次选择生效，并在下次打开时回退到默认值。
  }
  document.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { enabled: next } }));
  return next;
}

// 设置面板只在页面加载时绑定一次；复选框初始值来自本地偏好。
export function bindCodeWorkViewSetting(root) {
  const input = root.querySelector("[data-code-work-view]");
  if (!(input instanceof HTMLInputElement)) return;
  input.checked = isCodeWorkViewEnabled();
  input.addEventListener("change", () => {
    setCodeWorkViewEnabled(input.checked);
  });
}
