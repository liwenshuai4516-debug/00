const { randomUUID } = require("node:crypto");

function createOAuthFlowManager(getRuntime) {
  const flows = new Map();
  const listeners = new Set();
  const view = flow => ({ id: flow.id, revision: flow.revision ?? 0, provider: flow.provider, status: flow.status, event: flow.event, prompt: flow.prompt?.view });
  function emit(flow) { flow.revision = (flow.revision ?? 0) + 1; for (const listener of listeners) listener(view(flow)); }
  async function start(provider) {
    const runtime = await getRuntime();
    if (!runtime.getProvider(provider)?.auth.oauth) throw new Error("该供应商不支持 OAuth 登录。");
    const existing = [...flows.values()].find(flow => flow.provider === provider && flow.status === "running");
    if (existing) return view(existing);
    const flow = { id: randomUUID(), provider, status: "running", controller: new AbortController() };
    flows.set(flow.id, flow);
    void Promise.resolve().then(() => runtime.login(provider, "oauth", {
      signal: flow.controller.signal,
      notify(event) {
        // 仅转发 SDK 定义的展示字段，排除令牌和内部对象。
        flow.event = event.type === "auth_url" ? { type: event.type, url: event.url, message: event.instructions }
          : event.type === "device_code" ? { type: event.type, url: event.verificationUri, code: event.userCode }
          : { type: event.type, message: event.message, links: event.type === "info" ? event.links?.map(({ url, label }) => ({ url, label })) : undefined };
        emit(flow);
      },
      prompt(prompt) {
        if (flow.controller.signal.aborted || prompt.signal?.aborted) return Promise.reject(new Error("登录已取消。"));
        return new Promise((resolve, reject) => {
          const id = randomUUID();
          const cleanup = () => {
            flow.controller.signal.removeEventListener("abort", abort);
            prompt.signal?.removeEventListener("abort", abort);
          };
          const abort = () => {
            cleanup(); flow.prompt = undefined; emit(flow); reject(new Error("登录已取消。"));
          };
          flow.prompt = { view: { id, type: prompt.type, message: prompt.message, placeholder: prompt.placeholder,
            options: prompt.type === "select" ? prompt.options.map(({ id, label }) => ({ id, label })) : undefined }, resolve, cleanup };
          flow.controller.signal.addEventListener("abort", abort, { once: true });
          prompt.signal?.addEventListener("abort", abort, { once: true });
          emit(flow);
        });
      },
    })).then(() => {
      flow.status = "success"; flow.event = { message: "登录成功。" };
    }, () => {
      flow.status = flow.controller.signal.aborted ? "cancelled" : "failed";
      flow.event = { message: flow.status === "cancelled" ? "登录已取消。" : "登录未完成，请重试或检查账号。" };
    }).finally(() => {
      flow.prompt?.cleanup(); flow.prompt = undefined; emit(flow);
      // 保留各供应商最后结果，重新打开设置时可继续查看。
      for (const [id, previous] of flows) if (id !== flow.id && previous.provider === provider && previous.status !== "running") flows.delete(id);
    });
    return view(flow);
  }
  function reply(flowId, promptId, value) {
    const flow = flows.get(flowId);
    if (!flow?.prompt || flow.prompt.view.id !== promptId || typeof value !== "string" || value.length > 16384) throw new Error("登录提示已失效。");
    if (flow.prompt.view.type === "select" && !flow.prompt.view.options.some(item => item.id === value)) throw new Error("请选择有效选项。");
    const prompt = flow.prompt; prompt.cleanup(); flow.prompt = undefined; prompt.resolve(value); emit(flow);
  }
  function cancel(id) { flows.get(id)?.controller.abort(); }
  return { start, reply, cancel, list: () => [...flows.values()].map(view),
    subscribe(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    dispose() { for (const flow of flows.values()) flow.controller.abort(); listeners.clear(); },
  };
}

module.exports = { createOAuthFlowManager };
