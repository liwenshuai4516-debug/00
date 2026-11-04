// 侧栏浏览器只接受 http(s)：补全裸域名，拒绝脚本、本地文件和数据协议。
export function normalizeBrowserUrl(input) {
  const value = typeof input === "string" ? input.trim() : "";
  if (value === "") return null;

  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`;

  let url;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  // 地址栏不接收带凭据的 URL，避免把账号密码写进历史或地址栏。
  if (url.username !== "" || url.password !== "") return null;
  return url.toString();
}
