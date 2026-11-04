// 只管理聊天区滚动，不参与消息发送或会话管理。
export function createMessageScroll(container, latestButton) {
  const BOTTOM_THRESHOLD = 32;
  let following = true;
  let scheduled = false;

  function update() {
    // 流式文本可能连续到达，同一帧只更新一次滚动位置。
    if (scheduled) return;
    scheduled = true;

    requestAnimationFrame(() => {
      scheduled = false;

      if (following) {
        container.scrollTop = container.scrollHeight;
      }

      latestButton.hidden = following;
    });
  }

  function followLatest() {
    following = true;
    update();
  }

  // 切换会话后恢复阅读位置；位置越界时夹在有效范围内。
  function restore(position = {}) {
    following = position.following !== false;
    const max = Math.max(0, container.scrollHeight - container.clientHeight);
    const top = Number(position.top);
    container.scrollTop = following || !Number.isFinite(top)
      ? max
      : Math.min(Math.max(0, top), max);
    latestButton.hidden = following;
  }

  function isFollowing() {
    return following;
  }

  container.addEventListener("scroll", () => {
    const gap =
      container.scrollHeight - container.clientHeight - container.scrollTop;

    // 上翻时暂停跟随，手动回到底部附近时恢复。
    following = gap <= BOTTOM_THRESHOLD;
    latestButton.hidden = following;
  }, { passive: true });

  latestButton.addEventListener("click", () => {
    followLatest();

    // 按钮随后会隐藏，将焦点移入可用键盘滚动的聊天区。
    container.focus({ preventScroll: true });
  });

  return { update, followLatest, restore, isFollowing };
}