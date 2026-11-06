const { spawn } = require("node:child_process");
const { createInterface } = require("node:readline");
const path = require("node:path");

// 探针与只读探索共用进程桥；done 必须与退出、浏览器收尾同时成立。
function startProbe({ python, message, onEvent = () => {}, timeoutMs = 190000, cancelGraceMs = 5000 }) {
  const child = spawn(python, [path.join(__dirname, "explore.py")], {
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      TMPDIR: path.join(message.output, "private"),
      BROWSER_USE_CONFIG_DIR: path.join(message.output, "private/config"),
      ANONYMIZED_TELEMETRY: "false",
      BROWSER_USE_CLOUD_SYNC: "false",
    },
  });
  let terminal;
  let fault;
  let cancelling = false;
  let escalation;
  const events = [];
  // 不把第三方 stderr 持久化，以免意外包含请求正文或认证信息。
  child.stderr.resume();
  function killGroup() {
    try {
      if (process.platform === "win32") child.kill("SIGKILL");
      else process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (error.code !== "ESRCH") fault ||= "termination-unconfirmed";
    }
  }
  function cancel() {
    if (cancelling || child.exitCode !== null) return;
    cancelling = true;
    child.stdin.write(JSON.stringify({ type: "cancel", taskId: message.taskId }) + "\n");
    escalation = setTimeout(killGroup, cancelGraceMs);
  }
  const timer = setTimeout(() => { fault ||= "timeout"; cancel(); }, timeoutMs);
  const completed = new Promise((resolve, reject) => {
    child.once("error", () => { fault = "process-start-failed"; });
    child.stdin.on("error", () => { fault ||= "stdin-failed"; });
    const lines = createInterface({ input: child.stdout });
    lines.on("line", (line) => {
      try {
        const event = JSON.parse(line);
        if (event.taskId !== message.taskId || !["progress", "action", "done", "error"].includes(event.type) || terminal) {
          throw new Error("protocol");
        }
        events.push(event);
        if (event.type === "done" || event.type === "error") {
          terminal = event;
          child.stdin.end();
        }
        onEvent(event);
      } catch {
        fault ||= "invalid-protocol";
        cancel();
      }
    });
    child.once("close", (code, signal) => {
      clearTimeout(timer);
      clearTimeout(escalation);
      const result = { terminal, code, signal, events, fault };
      if (fault || terminal?.type !== "done" || !terminal.cleanupConfirmed ||
          !["completed", "cancelled"].includes(terminal.status) || code !== 0 ||
          (cancelling && terminal.status !== "cancelled")) {
        const error = new Error(fault || terminal?.reason || "incomplete-process-result");
        error.result = result;
        reject(error);
      } else resolve(result);
    });
  });
  child.stdin.write(JSON.stringify(message) + "\n");
  return { completed, cancel };
}

module.exports = { startProbe };
