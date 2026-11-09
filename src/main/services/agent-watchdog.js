const IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 30 * 1000;

// 只负责当前一次运行的计时；继续任务由持有发送锁的恢复链路处理。
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
