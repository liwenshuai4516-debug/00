// 页面仍用原忙碌状态收尾；关闭状态只阻止新操作，不冒充当前操作结束。
export function createWindowCloseController({ api, readState, flushAll, setClosing, onError }) {
  let active = false;
  let disposed = false;
  let wake = null;

  function notify() {
    wake?.();
  }

  async function prepare(requestId) {
    if (disposed || active || typeof requestId !== "string" || !requestId) return;
    active = true;
    try {
      setClosing(true);
      let stopped = false;
      let canceled = false;
      for (;;) {
        if (disposed) return;
        const state = readState();
        if (!state.busy) break;
        // 先订阅变化，再停止，避免漏掉停止期间已经完成的操作。
        const changed = new Promise(resolve => { wake = resolve; });
        if (state.generating && !stopped) {
          stopped = true;
          await api.stop();
        } else if (state.compacting && !canceled) {
          canceled = true;
          await api.cancelCompaction();
        } else {
          await changed;
        }
        wake = null;
      }
      await flushAll();
      if (!disposed) api.reportCloseResult(requestId, true);
      // 成功后保持冻结，直到主进程真正关闭；不释放输入组件。
    } catch (error) {
      if (disposed) return;
      try {
        api.reportCloseResult(requestId, false);
      } finally {
        active = false;
        setClosing(false);
        onError(error);
      }
    }
  }

  // 必须先订阅，再报告就绪；ready不是保存成功确认。
  const unsubscribe = api.onPrepareClose(requestId => { void prepare(requestId); });
  api.closeReady();

  return {
    notify,
    dispose() {
      disposed = true;
      unsubscribe();
      notify();
    },
  };
}