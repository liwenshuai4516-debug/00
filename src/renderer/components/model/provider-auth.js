export function createProviderAuthPanel(root, api, setPageBusy, refreshProfiles) {
  const provider = root.querySelector("[data-auth-provider]");
  const keys = root.querySelector("[data-provider-keys]");
  const status = root.querySelector("[data-auth-status]");
  const flowArea = root.querySelector("[data-oauth-flow]");
  const keyForm = root.querySelector("form");
  let providers = [], busy = true, loading = false, version = 0, loadVersion = 0, flows = [], auth;
  function update() {
    for (const element of root.querySelectorAll("button, input, select")) element.disabled = busy || loading || !provider.value;
    provider.disabled = busy || loading || !providers.length;
    const capability = providers.find(item => item.id === provider.value);
    root.querySelector("[data-login]").hidden = !capability?.supportsOAuth;
    root.querySelector("[data-logout]").hidden = !capability?.supportsOAuth;
    keyForm.hidden = capability?.supportsApiKey === false;
    root.querySelector("[data-login]").disabled ||= flows.some(flow => flow.provider === provider.value && flow.status === "running");
    // 取消与登录回复不占用页面互斥，登录等待期间仍可使用。
    for (const element of flowArea.querySelectorAll("button, input, select")) element.disabled = busy || loading;
  }
  function renderKeys() {
    keys.replaceChildren();
    for (const item of auth?.keys ?? []) {
      const row = document.createElement("div"); row.className = "provider-key-row";
      const label = document.createElement("span");
      label.textContent = item.name + (auth.mode === "api_key" && item.id === auth.activeKeyId ? " · 使用中" : "");
      const activate = document.createElement("button"); activate.type = "button"; activate.textContent = "使用";
      activate.addEventListener("click", () => void mutate(() => api.activateProviderKey(provider.value, item.id), "已切换激活密钥。"));
      const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "删除";
      remove.addEventListener("click", () => {
        if (window.confirm("删除此密钥？若正在使用，将停止使用此密钥，不会自动切换到其他密钥。")) void mutate(() => api.removeProviderKey(provider.value, item.id), "密钥已删除。");
      });
      row.append(label, activate, remove); keys.append(row);
    }
    update();
  }
  function renderFlow() {
    flowArea.replaceChildren();
    const flow = flows.findLast(item => item.provider === provider.value);
    if (!flow) { update(); return; }
    const info = document.createElement("p");
    info.textContent = flow.event?.message || (flow.status === "running" ? "登录进行中……" : "登录已结束。");
    flowArea.append(info);
    if (flow.event?.code) {
      const code = document.createElement("code"); code.textContent = flow.event.code; flowArea.append(code);
    }
    if (flow.status !== "running") { update(); return; }
    if (flow.event?.url || flow.event?.links?.length) {
      const open = document.createElement("button"); open.type = "button"; open.textContent = "打开登录页面";
      open.addEventListener("click", () => { void api.openProviderOAuthLink(flow.id).catch(error => { status.textContent = error.message; }); });
      flowArea.append(open);
    }
    if (flow.prompt) {
      const prompt = flow.prompt;
      const label = document.createElement("label"); label.htmlFor = "provider-oauth-response"; label.textContent = prompt.message;
      const input = document.createElement(prompt.type === "select" ? "select" : "input");
      input.id = "provider-oauth-response";
      if (prompt.type === "select") {
        for (const item of prompt.options) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.label; input.append(option); }
      } else { input.type = prompt.type === "secret" ? "password" : "text"; input.autocomplete = "off"; input.placeholder = prompt.placeholder || ""; }
      const submit = document.createElement("button"); submit.type = "button"; submit.textContent = "继续登录";
      const reply = async () => {
        const value = input.value; input.value = ""; submit.disabled = true;
        try { await api.replyProviderOAuth(flow.id, prompt.id, value); }
        catch (error) { status.textContent = error.message; submit.disabled = false; }
      };
      submit.addEventListener("click", () => void reply());
      input.addEventListener("keydown", event => { if (event.key === "Enter" && !event.isComposing) { event.preventDefault(); void reply(); } });
      flowArea.append(label, input, submit);
    }
    const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "取消登录";
    cancel.addEventListener("click", () => { void api.cancelProviderOAuth(flow.id).catch(error => { status.textContent = error.message; }); });
    flowArea.append(cancel); update();
  }
  async function refresh() {
    if (!provider.value || !api.providerAuth) return;
    const token = ++version;
    loading = true; update();
    try {
      const result = await api.providerAuth(provider.value);
      if (token !== version) return;
      auth = result;
      status.textContent = result.oauth ? "已通过 OAuth 登录。" : result.configured ? "供应商已配置凭据。" : "尚未配置可用凭据。";
      renderKeys();
    } catch (error) { if (token === version) { auth = undefined; keys.replaceChildren(); status.textContent = `凭据读取失败：${error.message}`; } }
    finally { if (token === version) { loading = false; update(); } }
  }
  async function mutate(action, message) {
    if (busy || loading) return;
    setPageBusy(true);
    let completed = false;
    try { await action(); completed = true; await refresh(); await refreshProfiles(); status.textContent = message; }
    catch (error) { status.textContent = `${completed ? "操作已完成，刷新失败" : "操作未完成"}：${error.message}`; }
    finally { keyForm.elements.key.value = ""; setPageBusy(false); update(); }
  }
  provider.addEventListener("change", () => { keyForm.elements.key.value = ""; renderFlow(); void refresh(); });
  keyForm.addEventListener("submit", event => {
    event.preventDefault();
    const name = keyForm.elements.keyName.value, key = keyForm.elements.key.value;
    void mutate(() => api.addProviderKey(provider.value, name, key), "密钥已加密保存。");
  });
  root.querySelector("[data-login]").addEventListener("click", () => {
    void mutate(async () => {
      const flow = await api.startProviderOAuth(provider.value);
      if (!flows.some(item => item.id === flow.id && item.revision > flow.revision)) {
        flows = flows.filter(item => item.id !== flow.id); flows.push(flow); renderFlow();
      }
    }, "请按登录提示继续。");
  });
  root.querySelector("[data-logout]").addEventListener("click", () => {
    if (window.confirm("退出该供应商的 OAuth 登录？使用此登录的配置将需要重新登录。")) void mutate(() => api.logoutProviderOAuth(provider.value), "已退出登录。");
  });
  root.querySelector("[data-refresh-auth]").addEventListener("click", () => void refresh());
  return {
    setBusy(value) { busy = value; update(); },
    async load(data) {
      const token = ++loadVersion;
      const selected = provider.value;
      const map = new Map((data.providers ?? []).map(item => [item.id, item]));
      for (const profile of data.profiles ?? []) if (!map.has(profile.provider)) map.set(profile.provider, { id: profile.provider, name: profile.provider, supportsApiKey: true });
      providers = [...map.values()]; provider.replaceChildren();
      for (const item of providers) { const option = document.createElement("option"); option.value = item.id; option.textContent = item.name; provider.append(option); }
      if (providers.some(item => item.id === selected)) provider.value = selected;
      if (api.listProviderOAuthFlows) {
        const restored = await api.listProviderOAuthFlows();
        if (token !== loadVersion) return;
        flows = restored;
      }
      renderFlow(); await refresh();
    },
    onEvent(event) {
      if (event.type !== "oauth") return;
      const flow = event.value;
      if (!flows.some(item => item.id === flow.id && item.revision > flow.revision)) {
        flows = flows.filter(item => item.id !== flow.id); flows.push(flow); renderFlow();
      }
      if (flow.provider === provider.value && flow.status !== "running") { void refresh(); void refreshProfiles().catch(() => { status.textContent = "登录状态已更新，对话信息刷新失败，可重试。"; }); }
    },
    close() { loadVersion++; version++; loading = false; keyForm.elements.key.value = ""; flowArea.replaceChildren(); },
  };
}
