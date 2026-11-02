const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(t, options = {}) {
  const { createWindowCloseController } = await import("../../src/renderer/components/window-close-controller.js");
  const calls = [];
  const state = { busy: false, generating: false, compacting: false };
  let listener;
  const api = {
    onPrepareClose(callback) { calls.push("subscribe"); listener = callback; return () => calls.push("unsubscribe"); },
    closeReady() { calls.push("ready"); },
    reportCloseResult(id, saved) { calls.push([id, saved]); },
    async stop() { calls.push("stop"); await options.stop?.(); },
    async cancelCompaction() { calls.push("cancel"); await options.cancel?.(); },
  };
  const controller = createWindowCloseController({
    api, readState: () => state,
    async flushAll() { calls.push("flush"); await options.flush?.(); },
    setClosing(value) { calls.push(["closing", value]); },
    onError(error) { calls.push(["error", error.message]); },
  });
  t.after(() => controller.dispose());
  const tick = () => new Promise(resolve => setImmediate(resolve));
  return {
    state, calls, controller, tick,
    request: id => listener(id),
    update(value) { Object.assign(state, value); controller.notify(); },
    results: () => calls.filter(item => Array.isArray(item) && item[0] !== "closing" && item[0] !== "error"),
  };
}

test("先监听再就绪；保存完成前不确认，成功后保留冻结", async t => {
  const gate = Promise.withResolvers();
  const s = await setup(t, { flush: () => gate.promise });
  assert.deepEqual(s.calls, ["subscribe", "ready"]);
  s.request("one"); await s.tick();
  assert.deepEqual(s.results(), []);
  assert.deepEqual(s.calls.slice(2), [["closing", true], "flush"]);
  gate.resolve(); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
  assert.equal(s.calls.some(item => item?.[0] === "closing" && item[1] === false), false);
});

test("保存失败回报false并恢复；再次关闭使用新编号重试", async t => {
  let fail = true;
  const s = await setup(t, { flush() { if (fail) throw Error("磁盘失败"); } });
  s.request("one"); await s.tick();
  assert.deepEqual(s.calls.slice(-3), [["one", false], ["closing", false], ["error", "磁盘失败"]]);
  fail = false; s.request("two"); await s.tick();
  assert.deepEqual(s.results(), [["one", false], ["two", true]]);
});

test("普通操作完成之前等待，重复关闭不另起保存", async t => {
  const s = await setup(t);
  s.update({ busy: true }); s.request("one"); s.request("one"); s.request("two");
  await s.tick(); assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
  assert.equal(s.calls.filter(item => item === "flush").length, 1);
});

test("生成中关闭先停止，停止返回仍等待发送及输入协调的收尾", async t => {
  const s = await setup(t);
  s.update({ busy: true, generating: true }); s.request("one"); await s.tick();
  assert.equal(s.calls.filter(item => item === "stop").length, 1);
  assert.equal(s.calls.includes("flush"), false);
  s.update({ generating: false }); await s.tick();
  assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("发送前保存阶段关闭，随后开始生成时也会停止", async t => {
  const s = await setup(t);
  s.update({ busy: true }); s.request("one"); await s.tick();
  assert.equal(s.calls.includes("stop"), false);
  s.update({ generating: true }); await s.tick();
  assert.equal(s.calls.includes("stop"), true);
  assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false, generating: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("整理中关闭取消整理，等待原操作结束才保存", async t => {
  const s = await setup(t);
  s.update({ busy: true, compacting: true }); s.request("one"); await s.tick();
  assert.equal(s.calls.includes("cancel"), true);
  assert.equal(s.calls.includes("flush"), false);
  s.update({ busy: false, compacting: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("停止或取消失败不继续确认保存，并允许再次尝试", async t => {
  for (const compacting of [false, true]) {
    let fail = true;
    const action = () => { if (fail) throw Error("停止失败"); };
    const s = await setup(t, { stop: action, cancel: action });
    s.update({ busy: true, generating: !compacting, compacting });
    s.request("one"); await s.tick();
    assert.deepEqual(s.results(), [["one", false]]);
    assert.equal(s.calls.includes("flush"), false);
    fail = false; s.request("two"); await s.tick();
    s.update({ busy: false, generating: false, compacting: false }); await s.tick();
    assert.deepEqual(s.results(), [["one", false], ["two", true]]);
  }
});

test("停止期间已经收尾的变化不丢失", async t => {
  const gate = Promise.withResolvers();
  const s = await setup(t, { stop: () => gate.promise });
  s.update({ busy: true, generating: true }); s.request("one");
  s.update({ busy: false, generating: false }); gate.resolve(); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("读取或输入法收尾仍忙时等待，直到通知就绪", async t => {
  const s = await setup(t);
  s.update({ busy: true }); s.request("one"); await s.tick();
  assert.deepEqual(s.results(), []);
  s.update({ busy: false }); await s.tick();
  assert.deepEqual(s.results(), [["one", true]]);
});

test("离开页面时移除监听，旧保存返回不能再确认关闭", async t => {
  const gate = Promise.withResolvers();
  const s = await setup(t, { flush: () => gate.promise });
  s.request("one"); s.controller.dispose(); gate.resolve(); await s.tick();
  assert.equal(s.calls.includes("unsubscribe"), true);
  assert.deepEqual(s.results(), []);
});

test("等待操作期间离开页面不再保存，无效请求不触发准备", async t => {
  const s = await setup(t);
  for (const value of [null, "", 1, {}]) s.request(value);
  assert.deepEqual(s.calls, ["subscribe", "ready"]);
  s.update({ busy: true }); s.request("one"); s.controller.dispose(); await s.tick();
  assert.equal(s.calls.includes("flush"), false);
  assert.deepEqual(s.results(), []);
});