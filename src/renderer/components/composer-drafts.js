// 只管理当前页面生命周期内的输入草稿，不写入磁盘或聊天历史。
export function createComposerDrafts(input) {
  const drafts = new Map();
  let currentId = null;

  function switchTo(sessionId) {
    // 刷新列表或重命名不会覆盖正在编辑的输入。
    if (currentId === sessionId) return;

    if (currentId !== null) {
      drafts.set(currentId, input.value);
      input.value = drafts.get(sessionId) ?? "";
    }

    // 首次绑定保留页面加载期间已经输入的文字。
    currentId = sessionId;
  }

  return { switchTo };
}