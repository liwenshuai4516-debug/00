// 右侧边栏外壳：贴右边缘的停靠列，只管理几何、开合和宽度；内容由页面挂到
// #right-sidebar-body，外壳不注册任何业务。
const STORAGE_KEY = "agent-client:right-sidebar";
export const RIGHT_SIDEBAR_MIN_WIDTH = 300;
/** DSH 同款上限：不超过视口 70%，并给中栏保留 400px。 */
const RIGHT_SIDEBAR_MAX_RATIO = 0.7;
/** 首次打开取视口 45%。 */
const RIGHT_SIDEBAR_DEFAULT_RATIO = 0.45;
const CENTER_MIN_WIDTH = 400;
/** 中栏过窄时先隐藏 header 入口，避免挤压会话标题。 */
const HEADER_MIN_CHAT_WIDTH = 160;
/** 低于该宽度打开时覆盖窗口，与 DSH 的窄屏全屏一致。 */
const NARROW_FULLSCREEN_BELOW = 768;
const KEYBOARD_STEP = 16;
const PERSIST_DELAY_MS = 200;

function clampWidth(px, min, max) {
  return Math.min(max, Math.max(min, Math.round(px)));
}

function readStoredWidth() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return null;
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return null;
    return typeof parsed.width === "number" && parsed.width > 0
      ? parsed.width
      : null;
  } catch {
    return null;
  }
}

/**
 * @param {object} options
 * @param {HTMLElement} options.sidebar 右侧栏根节点
 * @param {HTMLButtonElement} options.toggle 会话 header 里的展开按钮
 * @param {HTMLButtonElement} options.close 面板内的收起按钮
 * @param {() => number} options.getLeftWidth 左侧栏当前宽度
 * @param {(options?: { persist?: boolean }) => void} [options.collapseLeft]
 */
export function createRightSidebar({
  sidebar,
  toggle,
  close,
  getLeftWidth,
  collapseLeft,
}) {
  const resize = sidebar.querySelector(".right-sidebar__resize");
  let open = false;
  let fullscreen = false;
  let width = readStoredWidth();
  let dragOrigin = null;
  let persistTimer;
  let geometryFrame = 0;

  function maxDockedWidth() {
    const viewport = window.innerWidth;
    return Math.min(
      Math.round(viewport * RIGHT_SIDEBAR_MAX_RATIO),
      viewport - getLeftWidth() - CENTER_MIN_WIDTH,
    );
  }

  function preferredWidth() {
    return Math.max(
      RIGHT_SIDEBAR_MIN_WIDTH,
      width ?? Math.round(window.innerWidth * RIGHT_SIDEBAR_DEFAULT_RATIO),
    );
  }

  function effectiveWidth() {
    const max = Math.max(RIGHT_SIDEBAR_MIN_WIDTH, maxDockedWidth());
    return clampWidth(
      Math.min(width ?? preferredWidth(), max),
      RIGHT_SIDEBAR_MIN_WIDTH,
      max,
    );
  }

  function syncWidth() {
    const effective = effectiveWidth();
    const max = Math.max(RIGHT_SIDEBAR_MIN_WIDTH, maxDockedWidth());
    sidebar.style.setProperty("--right-sidebar-width", `${effective}px`);
    resize.setAttribute("aria-valuenow", String(effective));
    resize.setAttribute("aria-valuemax", String(max));
    return effective;
  }

  function syncBackgroundInert() {
    const inert = open && fullscreen;
    for (const element of [
      document.getElementById("app-sidebar"),
      document.querySelector(".chat-main"),
    ]) {
      if (element !== null) element.toggleAttribute("inert", inert);
    }
  }

  function syncHeaderButton() {
    const hidden = open
      || window.innerWidth - getLeftWidth() < HEADER_MIN_CHAT_WIDTH;
    const wasFocused = document.activeElement === toggle;
    toggle.hidden = hidden;
    // 入口被隐藏时，把焦点交给仍然可见的左侧栏按钮。
    if (hidden && wasFocused && !open) {
      document.getElementById("sidebar-toggle")?.focus();
    }
  }

  function syncOpen() {
    sidebar.toggleAttribute("data-open", open);
    sidebar.toggleAttribute("data-fullscreen", open && fullscreen);
    toggle.hidden = open;
    toggle.setAttribute("aria-expanded", String(open));
    if (open) {
      sidebar.removeAttribute("inert");
      sidebar.removeAttribute("aria-hidden");
    } else {
      sidebar.setAttribute("inert", "");
      sidebar.setAttribute("aria-hidden", "true");
    }
    syncBackgroundInert();
    syncHeaderButton();
  }

  function persist() {
    if (width === null) return;
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ width }),
        );
      } catch {
        // 隐私模式等写入失败时忽略，当前宽度仍在内存里生效。
      }
    }, PERSIST_DELAY_MS);
  }

  function openPanel() {
    if (open) return;
    // 与 DSH 一致：窄于 1024 打开右栏时先收起左栏，给中栏让位。
    if (window.innerWidth < 1024) collapseLeft?.({ persist: false });
    // 宽屏下左栏拖得很宽时也先让位，避免右栏没有 300px 可用空间。
    if (maxDockedWidth() < RIGHT_SIDEBAR_MIN_WIDTH) {
      collapseLeft?.({ persist: false });
    }
    fullscreen = window.innerWidth < NARROW_FULLSCREEN_BELOW;
    if (!fullscreen) {
      width ??= preferredWidth();
      syncWidth();
    }
    open = true;
    syncOpen();
    close.focus();
  }

  function closePanel() {
    if (!open) return;
    open = false;
    fullscreen = false;
    syncOpen();
    if (!toggle.hidden) toggle.focus();
    else document.getElementById("sidebar-toggle")?.focus();
  }

  function setUserWidth(px) {
    if (!open || fullscreen) return;
    const max = Math.max(RIGHT_SIDEBAR_MIN_WIDTH, maxDockedWidth());
    const current = effectiveWidth();
    const next = clampWidth(px, RIGHT_SIDEBAR_MIN_WIDTH, max);
    if (next === current && next === width) return;
    width = next;
    sidebar.style.setProperty("--right-sidebar-width", `${next}px`);
    resize.setAttribute("aria-valuenow", String(next));
    resize.setAttribute("aria-valuemax", String(max));
    persist();
  }

  function handleGeometryChange() {
    // 先同步更新 header 入口，避免左栏展开的同一帧出现横向溢出。
    syncHeaderButton();
    window.cancelAnimationFrame(geometryFrame);
    geometryFrame = window.requestAnimationFrame(() => {
      if (!open || fullscreen) return;
      if (window.innerWidth < NARROW_FULLSCREEN_BELOW) {
        fullscreen = true;
        syncOpen();
        return;
      }
      if (maxDockedWidth() < RIGHT_SIDEBAR_MIN_WIDTH) {
        // 左栏重新展开导致中栏不足 400px 时收起右栏，与 DSH 的让位规则一致。
        closePanel();
        return;
      }
      syncWidth();
    });
  }

  toggle.addEventListener("click", openPanel);
  close.addEventListener("click", closePanel);

  resize.addEventListener("pointerdown", (event) => {
    if (!open || fullscreen || event.button !== 0) return;
    resize.setPointerCapture(event.pointerId);
    dragOrigin = { x: event.clientX, width: effectiveWidth() };
    sidebar.setAttribute("data-dragging", "");
  });
  resize.addEventListener("pointermove", (event) => {
    if (dragOrigin === null || !resize.hasPointerCapture(event.pointerId)) {
      return;
    }
    setUserWidth(dragOrigin.width - (event.clientX - dragOrigin.x));
  });
  function endDrag(event) {
    if (dragOrigin === null) return;
    if (resize.hasPointerCapture(event.pointerId)) {
      resize.releasePointerCapture(event.pointerId);
    }
    dragOrigin = null;
    sidebar.removeAttribute("data-dragging");
    persist();
  }
  resize.addEventListener("pointerup", endDrag);
  resize.addEventListener("pointercancel", endDrag);

  resize.addEventListener("keydown", (event) => {
    if (!open || fullscreen) return;
    const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
    const current = effectiveWidth();
    let next;
    if (event.key === "ArrowLeft") next = current + step;
    else if (event.key === "ArrowRight") next = current - step;
    else if (event.key === "Home") next = RIGHT_SIDEBAR_MIN_WIDTH;
    else if (event.key === "End") next = maxDockedWidth();
    else return;
    event.preventDefault();
    sidebar.setAttribute("data-dragging", "");
    setUserWidth(next);
    window.requestAnimationFrame(() => {
      sidebar.removeAttribute("data-dragging");
    });
  });

  window.addEventListener("resize", handleGeometryChange);
  // 左侧栏展开/收起会改变中栏可用宽度；状态事件比观察器更及时。
  document.addEventListener("sidebar-state-change", handleGeometryChange);
  let leftObserver = null;
  if (typeof ResizeObserver === "function") {
    const left = document.getElementById("app-sidebar");
    if (left !== null) {
      leftObserver = new ResizeObserver(handleGeometryChange);
      leftObserver.observe(left);
    }
  }

  syncOpen();
  return {
    open: openPanel,
    close: closePanel,
    isOpen: () => open,
    isFullscreen: () => fullscreen,
  };
}
