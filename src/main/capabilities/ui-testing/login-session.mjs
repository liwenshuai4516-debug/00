import { fork } from "node:child_process";
import { mkdtemp, chmod, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

function receive(child, expected, signal) {
  return new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      child.off("message", onMessage);
      child.off("exit", onExit);
      child.off("error", onError);
      signal?.removeEventListener("abort", onAbort);
      error ? reject(error) : resolve();
    };
    const onMessage = (message) => {
      if (message.status === expected) finish();
      else if (message.status === "error") finish(new Error(message.message));
    };
    const onExit = () => finish(new Error("登录窗口已关闭，请重新开始。"));
    const onError = () => finish(new Error("登录进程启动失败。"));
    const onAbort = () => finish(new Error("登录操作已取消。"));
    const timer = setTimeout(() => finish(new Error("登录窗口响应超时。")), 30_000);
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
    env: { ...process.env, NODE_PATH: runtime.modules, PLAYWRIGHT_BROWSERS_PATH: runtime.browsers },
    stdio: ["ignore", "ignore", "ignore", "ipc"],
  });
  const entry = {
    directory,
    file: path.join(directory, "state.json"),
    origin: new URL(targetUrl).origin,
    status: "open",
    async save(signal) {
      if (!child.connected) throw new Error("登录窗口已关闭，请重新登录。");
      const waiting = receive(child, "saved", signal);
      child.send({ action: "save", file: entry.file });
      await waiting;
      entry.status = "saved";
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
      if (forced) throw new Error("私有文件已删除，但登录窗口被强制结束，浏览器收尾状态未知。");
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
