// 侧栏外壳：折叠几何、宽度与轨道状态；会话内容仍由页面组件维护。
const STORAGE_KEY = "agent-client:sidebar";
export const SIDEBAR_MIN_WIDTH = 264;
export const SIDEBAR_MAX_WIDTH = 420;
export const SIDEBAR_DEFAULT_WIDTH = 280;
export const SIDEBAR_RAIL_WIDTH = 56;
/** 视口窄于该值时自动收成轨道；沿用原窄窗断点，手动展开只影响当前窗口宽度。 */
export const SIDEBAR_AUTO_COLLAPSE_BELOW = 760;

/** 收起动画的冻结时长：与 CSS 里 --sidebar-fade（150ms）一致。 */
const SETTLE_MS = 150;
/** 指针离开侧栏后，滚动条滑块再保留多久。 */
const SCROLLBAR_LINGER_MS = 2000;
/** 键盘调整宽度时的步长。 */
const KEYBOARD_STEP = 16;
/** 拖拽改宽时合并写入，避免每帧写 localStorage。 */
const PERSIST_DELAY_MS = 200;

function clampWidth(px) {
  return Math.min(
    SIDEBAR_MAX_WIDTH,
    Math.max(SIDEBAR_MIN_WIDTH, Math.round(px)),
  );
}

function readStored() {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (raw === null) return {};
    const parsed = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return {};
    return {
      ...(typeof parsed.collapsed === "boolean"
        ? { collapsed: parsed.collapsed }
        : {}),
      ...(typeof parsed.width === "number" ? { width: parsed.width } : {}),
    };
  } catch {
    return {};
  }
}

/**
 * @param {object} options
 * @param {HTMLElement} options.sidebar 侧栏根节点
 * @param {HTMLButtonElement} options.toggle 折叠按钮
 * @param {() => void} [options.onCollapse] 开始收起前调用，用于关闭内部浮层
 */
export function createSidebarShell({ sidebar, toggle, onCollapse }) {
  const inner = sidebar.querySelector(".sidebar__inner");
  const wide = sidebar.querySelector(".sidebar__wide");
  const rail = sidebar.querySelector(".sidebar__rail");
  const resize = sidebar.querySelector(".sidebar__resize");
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const narrowQuery = window.matchMedia(
    `(max-width: ${SIDEBAR_AUTO_COLLAPSE_BELOW - 1}px)`,
  );

  const stored = readStored();
  let storedCollapsed = stored.collapsed ?? false;
  // 右侧栏打开时临时收起，不写回左栏的展开偏好。
  let temporaryCollapsed = false;
  let width = clampWidth(stored.width ?? SIDEBAR_DEFAULT_WIDTH);
  let narrow = narrowQuery.matches;
  let narrowExpanded = false;

  let settled = isCollapsed();
  let everWide = !settled;
  let lastCollapsed = settled;
  let settleTimer;
  let railTimer;
  let expandTimer;
  let lingerTimer;
  let persistTimer;
  let dragOrigin = null;
  let collapseFocus = false;

  function isCollapsed() {
    return narrow ? !narrowExpanded : storedCollapsed || temporaryCollapsed;
  }

  function setWidth(px) {
    sidebar.style.width = `${px}px`;
    resize.setAttribute("aria-valuenow", String(Math.round(px)));
  }

  function setInnerWidth(px) {
    inner.style.setProperty("--sidebar-inner-width", `${px}px`);
  }

  function syncToggle(collapsed) {
    sidebar.dataset.collapsed = String(collapsed);
    toggle.setAttribute("aria-expanded", String(!collapsed));
    const label = collapsed ? "展开侧栏" : "收起侧栏";
    toggle.setAttribute("aria-label", label);
    toggle.title = label;
    // 右栏外壳根据左栏宽度决定 header 入口是否可用。
    document.dispatchEvent(new CustomEvent("sidebar-state-change"));
  }

  function persist() {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      try {
        window.localStorage.setItem(
          STORAGE_KEY,
          JSON.stringify({ collapsed: storedCollapsed, width }),
        );
      } catch {
        // 隐私模式等场景写入失败时忽略，状态仍在内存里生效。
      }
    }, PERSIST_DELAY_MS);
  }

  function animateWide() {
    if (reducedMotion.matches) return;
    sidebar.classList.remove("sidebar--expanding");
    void sidebar.offsetWidth;
    sidebar.classList.add("sidebar--expanding");
    window.clearTimeout(expandTimer);
    expandTimer = window.setTimeout(() => {
      sidebar.classList.remove("sidebar--expanding");
    }, 200);
  }

  function finishCollapse(animate) {
    window.clearTimeout(settleTimer);
    settled = true;
    sidebar.classList.remove("sidebar--fading");
    sidebar.classList.add("sidebar--rail");
    setWidth(SIDEBAR_RAIL_WIDTH);
    setInnerWidth(SIDEBAR_RAIL_WIDTH);
    // 收起动画结束时焦点不能留在已经隐藏的宽内容里；业务代码已把焦点
    // 移到聊天输入框时不再抢回。
    const active = document.activeElement;
    const restoreFocus = collapseFocus
      && (active === document.body || wide.contains(active) || toggle === active);
    wide.hidden = true;
    rail.hidden = false;
    if (restoreFocus) toggle.focus();
    collapseFocus = false;
    if (animate && everWide && !reducedMotion.matches) {
      sidebar.classList.remove("sidebar--rail-in");
      void sidebar.offsetWidth;
      sidebar.classList.add("sidebar--rail-in");
      window.clearTimeout(railTimer);
      railTimer = window.setTimeout(() => {
        sidebar.classList.remove("sidebar--rail-in");
      }, SETTLE_MS * 2);
    }
  }

  function apply({ initial = false } = {}) {
    const collapsed = isCollapsed();
    window.clearTimeout(settleTimer);
    if (collapsed && !lastCollapsed) {
      collapseFocus = sidebar.contains(document.activeElement);
      onCollapse?.();
    }
    lastCollapsed = collapsed;
    syncToggle(collapsed);

    if (!collapsed) {
      settled = false;
      everWide = true;
      // 轨道按钮在展开后卸载，焦点交回折叠按钮，避免落到页面根节点。
      const railHadFocus = rail.contains(document.activeElement);
      sidebar.classList.remove("sidebar--rail", "sidebar--fading");
      sidebar.classList.remove("sidebar--rail-in");
      wide.hidden = false;
      rail.hidden = true;
      setWidth(width);
      setInnerWidth(width);
      if (!initial) animateWide();
      if (railHadFocus) toggle.focus();
      return;
    }

    if (settled) {
      finishCollapse(false);
      return;
    }

    // 开始收起：外层变窄，内层冻结在展开宽度并原地淡出，避免内容重排。
    sidebar.classList.remove("sidebar--rail-in", "sidebar--expanding");
    sidebar.classList.add("sidebar--fading");
    setWidth(SIDEBAR_RAIL_WIDTH);
    setInnerWidth(width);
    if (reducedMotion.matches) {
      finishCollapse(false);
      return;
    }
    settleTimer = window.setTimeout(() => finishCollapse(true), SETTLE_MS);
  }

  function expand() {
    if (!isCollapsed()) return;
    if (narrow) narrowExpanded = true;
    else {
      storedCollapsed = false;
      temporaryCollapsed = false;
    }
    persist();
    apply();
  }

  function collapse({ persist: shouldPersist = true } = {}) {
    if (isCollapsed()) return;
    if (narrow) narrowExpanded = false;
    else if (shouldPersist) {
      storedCollapsed = true;
      temporaryCollapsed = false;
    } else {
      temporaryCollapsed = true;
    }
    if (shouldPersist) persist();
    apply();
  }

  function toggleSidebar() {
    if (narrow) {
      narrowExpanded = isCollapsed();
    } else if (isCollapsed()) {
      storedCollapsed = false;
      temporaryCollapsed = false;
    } else {
      storedCollapsed = true;
      temporaryCollapsed = false;
    }
    persist();
    apply();
  }

  function setUserWidth(px) {
    const next = clampWidth(px);
    if (next === width) return;
    width = next;
    if (!isCollapsed()) {
      setWidth(next);
      setInnerWidth(next);
    }
    persist();
  }

  function handleNarrowChange() {
    narrow = narrowQuery.matches;
    // 窗口变宽后回到用户的持久化选择，不保留窄窗的临时展开。
    if (!narrow) narrowExpanded = false;
    apply();
  }

  narrowQuery.addEventListener("change", handleNarrowChange);
  reducedMotion.addEventListener("change", () => {
    if (reducedMotion.matches && !settled) finishCollapse(false);
  });

  toggle.addEventListener("click", toggleSidebar);

  // 轨道图标按约定只负责展开侧栏，不直接执行对应业务。
  sidebar.querySelectorAll("[data-sidebar-expand]").forEach((button) => {
    button.addEventListener("click", expand);
  });

  resize.addEventListener("pointerdown", (event) => {
    if (isCollapsed() || event.button !== 0) return;
    resize.setPointerCapture(event.pointerId);
    dragOrigin = { x: event.clientX, width };
    sidebar.classList.add("sidebar--dragging");
  });
  resize.addEventListener("pointermove", (event) => {
    if (dragOrigin === null || !resize.hasPointerCapture(event.pointerId)) {
      return;
    }
    setUserWidth(dragOrigin.width + event.clientX - dragOrigin.x);
  });
  function endDrag(event) {
    if (dragOrigin === null) return;
    if (resize.hasPointerCapture(event.pointerId)) {
      resize.releasePointerCapture(event.pointerId);
    }
    dragOrigin = null;
    sidebar.classList.remove("sidebar--dragging");
    persist();
  }
  resize.addEventListener("pointerup", endDrag);
  resize.addEventListener("pointercancel", endDrag);

  resize.addEventListener("keydown", (event) => {
    if (isCollapsed()) return;
    const step = event.shiftKey ? KEYBOARD_STEP * 4 : KEYBOARD_STEP;
    let next;
    if (event.key === "ArrowLeft") next = width - step;
    else if (event.key === "ArrowRight") next = width + step;
    else if (event.key === "Home") next = SIDEBAR_MIN_WIDTH;
    else if (event.key === "End") next = SIDEBAR_MAX_WIDTH;
    else return;
    event.preventDefault();
    // 键盘改宽不播过渡：先关掉 transition，改完下一帧再打开。
    sidebar.classList.add("sidebar--dragging");
    setUserWidth(next);
    window.requestAnimationFrame(() => {
      sidebar.classList.remove("sidebar--dragging");
    });
  });

  // 滚动条只是指针可供性：指针进入栏内才画，离开后再保留 2s。
  sidebar.addEventListener("pointerenter", () => {
    window.clearTimeout(lingerTimer);
    sidebar.classList.remove("sidebar--quiet");
  });
  sidebar.addEventListener("pointerleave", () => {
    window.clearTimeout(lingerTimer);
    lingerTimer = window.setTimeout(() => {
      sidebar.classList.add("sidebar--quiet");
    }, SCROLLBAR_LINGER_MS);
  });

  syncToggle(settled);
  apply({ initial: true });

  return {
    expand,
    collapse,
    toggle: toggleSidebar,
    isCollapsed,
    isNarrow: () => narrow,
    getWidth: () => (isCollapsed() ? SIDEBAR_RAIL_WIDTH : width),
  };
}
