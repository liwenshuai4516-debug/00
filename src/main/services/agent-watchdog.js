const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 30 * 1000;

// 只监督当前请求，不重放请求，也不把取消信号当成已经停止。
function createAgentWatchdog({ onTimeout, onUnresponsive, isWaitingForInput }) {
  let idleTimer;
  let stopTimer;
  let triggered = false;
  let disposed = false;

  function touch() {
    if (disposed || triggered) return;
    clearTimeout(idleTimer);
    idleTimer = setTimeout(() => {
      if (isWaitingForInput()) {
        touch();
        return;
      }
      triggered = true;
      stopTimer = setTimeout(onUnresponsive, STOP_GRACE_MS);
      stopTimer.unref?.();
      onTimeout();
    }, IDLE_TIMEOUT_MS);
    idleTimer.unref?.();
  }

  function dispose() {
    disposed = true;
    clearTimeout(idleTimer);
    clearTimeout(stopTimer);
  }

  touch();
  return { touch, dispose };
}

module.exports = { createAgentWatchdog };
