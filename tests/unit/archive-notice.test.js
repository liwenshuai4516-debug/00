const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const { runInNewContext } = require("node:vm");
const path = require("node:path");

function setup() {
  let now = 0, serial = 0, create;
  const timers = new Map(), calls = [];
  class Element {
    constructor() { this.children = []; this.handlers = new Map(); this.hidden = false; }
    append(...children) { this.children.push(...children); }
    setAttribute() {}
    addEventListener(name, callback) { this.handlers.set(name, callback); }
    contains(child) { return this.children.includes(child); }
    fire(name) { this.handlers.get(name)?.(); }
  }
  const document = { activeElement: null, createElement: () => new Element() };
  const source = readFileSync(path.join(__dirname, "../../src/renderer/components/archive-notice.js"), "utf8")
    .replace("export function createArchiveNotice", "function createArchiveNotice");
  runInNewContext(source + "\ngetCreate(createArchiveNotice);", {
    document, performance: { now: () => now }, queueMicrotask: callback => callback(),
    setTimeout(callback, delay) { const id = ++serial; timers.set(id, { callback, at: now + delay }); return id; },
    clearTimeout: id => timers.delete(id), getCreate(value) { create = value; },
  });
  const notice = create(id => calls.push(id));
  const element = notice.element, button = element.children[1];
  function tick(milliseconds) {
    now += milliseconds;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= now) { timers.delete(id); timer.callback(); }
    }
  }
  return { notice, element, button, document, tick, calls, timers };
}

test("撤销提示8秒消失，显示新的归档时重新计时", () => {
  const s = setup(); s.notice.show("a"); s.tick(7999); assert.equal(s.element.hidden, false);
  s.tick(1); assert.equal(s.element.hidden, true);
  s.notice.show("b"); s.tick(7000); s.notice.show("c"); s.tick(1000); assert.equal(s.element.hidden, false);
  s.button.fire("click"); assert.deepEqual(s.calls, ["c"]);
});

test("指针和键盘聚焦暂停剩余时间，离开后继续，忙碌禁止撤销", () => {
  const s = setup(); s.notice.show("a"); s.tick(2000);
  s.element.fire("pointerenter"); s.tick(10000); assert.equal(s.element.hidden, false);
  s.document.activeElement = s.button; s.element.fire("focusin"); s.element.fire("pointerleave");
  s.tick(10000); assert.equal(s.element.hidden, false);
  s.notice.setBusy(true); s.button.fire("click"); assert.deepEqual(s.calls, []);
  s.document.activeElement = null; s.element.fire("focusout"); s.tick(10000); assert.equal(s.element.hidden, false);
  s.notice.setBusy(false); s.tick(5999); assert.equal(s.element.hidden, false);
  s.tick(1); assert.equal(s.element.hidden, true);
});

test("恢复对应记录或页面释放才清除，不误清其他归档的撤销入口", () => {
  const s = setup(); s.notice.show("a"); s.notice.restored("b"); assert.equal(s.element.hidden, false);
  s.notice.restored("a"); assert.equal(s.element.hidden, true); assert.equal(s.timers.size, 0);
  s.notice.show("c"); s.notice.dispose(); assert.equal(s.element.hidden, true); assert.equal(s.timers.size, 0);
});
