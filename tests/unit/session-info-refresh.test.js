const { test } = require("node:test");
const assert = require("node:assert/strict");

async function setup(readInfo) {
  const { createSessionInfoPanel } = await import("../../src/renderer/components/session-info-panel.js");
  const element = { textContent: "" }, states = [];
  let sessionId = "a";
  const panel = createSessionInfoPanel(element, readInfo, {
    readSessionId: () => sessionId,
    onState: state => states.push(state),
  });
  return { panel, element, states, select(id) { sessionId = id; panel.invalidate(); } };
}

const info = (sessionId = "a", modelId = "first", usage = null) => ({
  sessionId, modelId, provider: "mock", workspaceDir: "/temporary/<img>", contextUsage: usage,
});

test("菜单与用量共享一次读取，零值及未知窗口保持原意，已刷新不重复读取", async () => {
  let calls = 0;
  let value = info("a", "first", { tokens: 0, percent: 0, contextWindow: 10000 });
  const s = await setup(async () => { calls++; return value; });
  await s.panel.refresh(); await s.panel.refreshIfNeeded();
  assert.equal(calls, 1);
  assert.match(s.element.textContent, /0 \/ 10,000 tokens（0.0%）/);
  assert.equal(s.states.at(-1).info, value);
  value = info("a", "first", { tokens: null, percent: null, contextWindow: 10000 });
  await s.panel.refresh();
  assert.match(s.element.textContent, /等待模型回复后更新/);
  assert.equal(s.states.at(-1).info.contextUsage.tokens, null);
});

for (const rejected of [false, true]) {
  test(`旧会话读取${rejected ? "失败" : "成功"}迟到不覆盖新会话`, async () => {
    const gate = Promise.withResolvers(); let calls = 0;
    const s = await setup(() => ++calls === 1 ? gate.promise : Promise.resolve(info("b", "next")));
    const old = s.panel.refresh(); s.select("b");
    assert.equal(s.states.at(-1).status, "loading");
    assert.doesNotMatch(s.element.textContent, /first/);
    await s.panel.refresh();
    const text = s.element.textContent, count = s.states.length;
    if (rejected) gate.reject(Error("旧失败")); else gate.resolve(info());
    await old;
    assert.equal(s.element.textContent, text); assert.equal(s.states.length, count);
    assert.equal(s.states.at(-1).info.sessionId, "b");
  });
}

test("同会话切换模型立即清旧数据，新请求完成后迟到旧模型不能覆盖", async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const s = await setup(() => ++calls === 1 ? gate.promise : Promise.resolve(info("a", "next")));
  const old = s.panel.refresh(); s.panel.invalidate();
  assert.equal(s.states.at(-1).status, "loading");
  await s.panel.refreshIfNeeded(); gate.resolve(info("a", "first")); await old;
  assert.match(s.element.textContent, /mock\/next/);
  assert.doesNotMatch(s.element.textContent, /mock\/first/);
});

test("返回编号不符明确失败，不展示其他会话数字，可只读重试", async () => {
  let value = info("other", "wrong", { tokens: 999, percent: 99, contextWindow: 1000 });
  const s = await setup(async () => value);
  await s.panel.refresh();
  assert.equal(s.states.at(-1).status, "error");
  assert.doesNotMatch(s.element.textContent, /999|wrong/);
  value = info(); await s.panel.refresh();
  assert.equal(s.states.at(-1).status, "ready");
});

test("失败移除旧估算，恢复读取后两处展示采用同一结果", async () => {
  let fail = false;
  const s = await setup(async () => { if (fail) throw Error("模拟读取失败"); return info(); });
  await s.panel.refresh(); fail = true; await s.panel.refresh();
  assert.equal(s.states.at(-1).status, "error"); assert.match(s.element.textContent, /模拟读取失败/);
  assert.equal(s.states.at(-1).info, undefined);
  fail = false; await s.panel.refresh(); assert.equal(s.states.at(-1).status, "ready");
});

test("页面离开后迟到响应失效，也不再发起新读取", async () => {
  const gate = Promise.withResolvers(); let calls = 0;
  const s = await setup(() => { calls++; return gate.promise; });
  const old = s.panel.refresh(); const count = s.states.length;
  s.panel.dispose(); gate.resolve(info()); await old; await s.panel.refresh();
  assert.equal(calls, 1); assert.equal(s.states.length, count);
});
