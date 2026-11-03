const closingSessions = new WeakMap();

// dispose() 不会发出 session_shutdown；必须等扩展释放资源后再销毁。
async function closePiSession(session, reason = "quit", targetSessionFile) {
  if (!session) return;
  let state = closingSessions.get(session);
  if (!state) {
    state = { shutdownSent: false, pending: null };
    closingSessions.set(session, state);
  }
  if (state.pending) return state.pending;

  state.pending = Promise.resolve().then(async () => {
    await session.abort?.();
    if (!state.shutdownSent) {
      await session.extensionRunner?.emit({ type: "session_shutdown", reason, targetSessionFile });
      state.shutdownSent = true;
    }
    await session.settingsManager?.flush();
    session.dispose();
  });
  try {
    await state.pending;
  } catch (error) {
    // 设置保存失败允许重试，但不重复通知扩展关闭。
    state.pending = null;
    throw error;
  }
}

module.exports = { closePiSession };
