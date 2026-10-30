const { test } = require("node:test");
const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");
const vm = require("node:vm");

const entry = require.resolve("../../src/main/main.js");
const source = readFileSync(entry, "utf8");

function runEntry({
  locked = true,
  hasWindow = true,
  minimized = false,
} = {}) {
  const calls = [];
  const handlers = new Map();

  const window = {
    isMinimized: () => minimized,
    restore: () => calls.push("restore"),
    show: () => calls.push("show"),
    focus: () => calls.push("focus"),
  };

  // 执行真实入口，替换外部模块。
  // 测试不启动 Electron 窗口，也不读取项目 .env。
  vm.runInNewContext(
    source,
    {
      require(name) {
        if (name === "electron") {
          return {
            app: {
              requestSingleInstanceLock() {
                calls.push("lock");
                return locked;
              },
              quit: () => calls.push("quit"),
              on: (event, handler) => {
                handlers.set(event, handler);
              },
            },
            BrowserWindow: {
              getAllWindows: () => hasWindow ? [window] : [],
            },
          };
        }

        if (name === "./bootstrap.js") {
          calls.push("bootstrap");

          return {
            createWindow: () => calls.push("create-window"),
          };
        }

        assert.fail(`入口不应提前加载其他模块：${name}`);
      },
    },
    { filename: entry },
  );

  return { calls, handlers };
}

test("拿不到锁时退出，不加载业务模块", () => {
  const { calls, handlers } = runEntry({ locked: false });

  assert.deepEqual(calls, ["lock", "quit"]);
  assert.equal(handlers.size, 0);
});

test("先获取锁，再执行业务启动", () => {
  const { calls, handlers } = runEntry();

  assert.deepEqual(calls, ["lock", "bootstrap"]);
  assert.equal(
    typeof handlers.get("second-instance"),
    "function",
  );
});

test("重复启动恢复最小化窗口，不重新组装服务", () => {
  const { calls, handlers } = runEntry({ minimized: true });

  handlers.get("second-instance")();

  assert.deepEqual(calls, [
    "lock",
    "bootstrap",
    "restore",
    "show",
    "focus",
  ]);
});

test("已有普通窗口时直接显示并聚焦", () => {
  const { calls, handlers } = runEntry();

  handlers.get("second-instance")();

  assert.deepEqual(calls, [
    "lock",
    "bootstrap",
    "show",
    "focus",
  ]);
});

test("原进程无窗口时重新创建窗口", () => {
  const { calls, handlers } = runEntry({ hasWindow: false });

  handlers.get("second-instance")();

  assert.deepEqual(calls, [
    "lock",
    "bootstrap",
    "create-window",
  ]);
});