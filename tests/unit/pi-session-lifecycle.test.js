const { test } = require("node:test");
const assert = require("node:assert/strict");
const { closePiSession } = require("../../src/main/resources/pi-session-lifecycle.js");

test("关闭并发停止父模型和子任务，等两者清理完成才销毁", async () => {
  const cancelled = Promise.withResolvers();
  let released = false;
  const session = {
    desktopSubagents: { async stop(close) { assert.equal(close, true); await cancelled.promise; released = true; } },
    async abort() { cancelled.resolve(); },
    dispose() { assert.equal(released, true); },
  };
  await closePiSession(session);
});

test("等待扩展清理和设置落盘后再 dispose，并发关闭只执行一次", async () => {
  const calls = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const session = {
    async abort() { calls.push("abort"); },
    extensionRunner: { async emit(event) {
      calls.push(event.reason);
      await blocked;
      calls.push("cleaned");
    } },
    settingsManager: { async flush() { calls.push("flush"); } },
    dispose() { calls.push("dispose"); },
  };
  const first = closePiSession(session, "new", "/tmp/target.jsonl");
  const second = closePiSession(session);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ["abort", "new"]);
  release();
  await Promise.all([first, second]);
  assert.deepEqual(calls, ["abort", "new", "cleaned", "flush", "dispose"]);
  await closePiSession(session);
  assert.equal(calls.length, 5);
});

test("设置写入失败允许重试，不重复发出 shutdown", async () => {
  let shutdowns = 0, flushes = 0, disposed = 0;
  const session = {
    extensionRunner: { async emit() { shutdowns += 1; } },
    settingsManager: { async flush() {
      if (++flushes === 1) throw new Error("暂时不可写");
    } },
    dispose() { disposed += 1; },
  };
  await assert.rejects(closePiSession(session), /暂时不可写/);
  assert.equal(disposed, 0);
  await closePiSession(session);
  assert.equal(shutdowns, 1);
  assert.equal(flushes, 2);
  assert.equal(disposed, 1);
});
