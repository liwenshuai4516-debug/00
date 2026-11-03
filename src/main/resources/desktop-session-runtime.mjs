import { AgentSessionRuntime } from "@mariozechner/pi-coding-agent";
import { realpath } from "node:fs/promises";
import { getSessionBindingError } from "../workspace/workspace-session.mjs";

export async function bindDesktopRuntime(initial, createReplacement, resourceOptions = {}) {
  const listeners = new Set();
  const runtime = new AgentSessionRuntime(initial, initial.desktopServices, async (target) => {
    const session = await createReplacement(target);
    return {
      session,
      services: session.desktopServices,
      extensionsResult: session.resourceLoader.getExtensions(),
      diagnostics: session.desktopResourceDiagnostics ?? [],
    };
  });
  let previous = initial;
  runtime.setBeforeSessionInvalidate(() => {
    runtime.session.desktopRuntimeInvalidated = true;
    resourceOptions.cancelUi?.(runtime.session.sessionId);
  });

  async function replace(operation) {
    // SDK 替换会释放旧会话；先确认设置落盘，失败时不进入替换。
    await runtime.session.settingsManager.flush();
    try {
      return await operation();
    } catch (error) {
      // setup/withSession 也可能在替换后失败；宿主必须跟随已发生的替换。
      if (runtime.session !== previous) await adopt(runtime.session);
      if (runtime.session.desktopRuntimeInvalidated) {
        throw new Error("Pi 会话替换失败，原会话已释放，请新建或重新打开对话。", { cause: error });
      }
      throw error;
    }
  }

  async function bind(session) {
    session.desktopRuntime = runtime;
    session.desktopRuntimeListeners = listeners;
    const baseUi = session.extensionRunner.getUIContext();
    const uiContext = resourceOptions.createUiContext?.(session, baseUi);
    await session.bindExtensions({
      mode: uiContext ? "rpc" : "json",
      uiContext,
      abortHandler: () => (resourceOptions.cancelPendingUi ?? resourceOptions.cancelUi)?.(session.sessionId),
      shutdownHandler: resourceOptions.shutdown,
      commandContextActions: {
        waitForIdle: () => runtime.session.waitForIdle(),
        newSession: (options) => replace(() => runtime.newSession(options)),
        fork: (entryId, options) => replace(async () => {
          const result = await runtime.fork(entryId, options);
          if (!result.cancelled && result.selectedText) runtime.session.extensionRunner.getUIContext().setEditorText(result.selectedText);
          return { cancelled: result.cancelled };
        }),
        navigateTree: async (targetId, options) => {
          const result = await runtime.session.navigateTree(targetId, options);
          session.desktopHistoryChanged = !result.cancelled;
          return { cancelled: result.cancelled };
        },
        switchSession: (sessionPath, options) => replace(async () => {
          // 先只读核对应用绑定，再交给官方 runtime 打开与替换。
          const path = await realpath(sessionPath);
          const { SessionManager } = await import("@mariozechner/pi-coding-agent");
          const selected = (await SessionManager.listAll(session.sessionManager.getSessionDir())).find(item => item.path === path);
          if (!selected) throw new Error("该历史不在应用会话目录中。");
          const error = await getSessionBindingError(path, await realpath(selected.cwd));
          if (error) throw new Error(error);
          await session.desktopBeforeSwitch?.(selected.id);
          return runtime.switchSession(path, options);
        }),
        reload: session.desktopReloadResources,
      },
      onError: session.desktopOnExtensionError,
    });
    session.desktopResourceDiagnostics ??= [];
    session.desktopResourceDiagnostics.push(...await session.desktopReportDiagnostics());
  }

  async function adopt(session) {
    const onReplacement = previous.desktopOnReplacement;
    resourceOptions.cancelUi?.(previous.sessionId);
    previous = session;
    try {
      await onReplacement?.(session);
    } finally {
      for (const listener of listeners) listener(session);
      await bind(session);
    }
  }
  runtime.setRebindSession(adopt);
  await bind(initial);
  return runtime;
}
