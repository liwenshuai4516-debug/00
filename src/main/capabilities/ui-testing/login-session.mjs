import { fork } from "node:child_process";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function receive(child, expected, signal, timeout = 30_000) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve(message);
    };
    const onMessage = (message) => {
      if (message.status === expected || message.event === expected) finish(null, message);
      else if (message.status === "error") finish(new Error(message.message));
    };
    const onExit = () => finish(new Error("后台登录进程已关闭，请重新开始。"));
    const onError = () => finish(new Error("登录进程启动失败。"));
    const onAbort = () => finish(new Error("登录操作已取消。"));
    const timer = setTimeout(() => finish(new Error("后台登录进程响应超时。")), timeout);
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

export async function openLogin(runtime, targetUrl, signal) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qa-ui-auth-"));
  await chmod(directory, 0o700);
  const child = fork(runtime.login, [targetUrl], {
    execPath: runtime.node,
    execArgv: [],
    env: {
      ...process.env,
      QA_UI_TEST_PASSWORD: "",
      NODE_PATH: runtime.modules,
      PLAYWRIGHT_BROWSERS_PATH: runtime.browsers,
    },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const entry = {
    directory,
    file: path.join(directory, "state.json"),
    origin: new URL(targetUrl).origin,
    status: "open",
    async auto(credentials, selectors, signal) {
      if (!child.connected) throw new Error("后台登录进程已关闭，请重新登录。");
      const waiting = receive(child, "auto-result", signal, 60_000);
      child.send({ action: "auto", credentials, selectors, file: entry.file });
      const message = await waiting;
      if (message.status === "saved") entry.status = "saved";
      return message;
    },
    async cleanup() {
      let forced = false;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        await new Promise((resolve) => {
          const timer = setTimeout(() => {
            forced = true;
            child.kill("SIGKILL");
          }, 5000);
          child.once("exit", () => { clearTimeout(timer); resolve(); });
          if (child.connected) child.send({ action: "close" }, () => {});
          else child.kill("SIGTERM");
        });
      }
      await rm(directory, { recursive: true, force: true });
      entry.status = "deleted";
      if (forced) throw new Error("私有文件已删除，但后台登录进程被强制结束，浏览器收尾状态未知。");
    },
  };
  try {
    await receive(child, "ready", signal);
    return entry;
  } catch (error) {
    await entry.cleanup();
    throw error;
  }
}
