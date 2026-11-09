// 用例工作区可能是自带 node_modules 的 JS 项目，就近解析会加载另一份 Playwright，
// 触发 “Requiring @playwright/test second time”。测试进程统一解析到随包依赖。
const Module = require("node:module");
const path = require("node:path");

const bundled = path.join(__dirname, "node_modules");
const isPlaywright = (request) => /^(@playwright\/test|playwright|playwright-core)(\/|$)/.test(request);
const original = Module._resolveFilename;

Module._resolveFilename = function (request, ...rest) {
  if (isPlaywright(request)) return original.call(this, path.join(bundled, request), ...rest);
  return original.call(this, request, ...rest);
};
