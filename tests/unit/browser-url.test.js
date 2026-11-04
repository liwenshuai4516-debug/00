const assert = require("node:assert/strict");
const { test } = require("node:test");

async function load() {
  return (await import("../../src/renderer/components/browser-url.js")).normalizeBrowserUrl;
}

test("裸域名补全 https，保留路径与查询", async () => {
  const normalize = await load();
  assert.equal(normalize("example.com"), "https://example.com/");
  assert.equal(normalize("example.com/a?b=1"), "https://example.com/a?b=1");
  assert.equal(normalize("http://localhost:3000/x#y"), "http://localhost:3000/x#y");
  assert.equal(normalize("  https://例子.测试/文档 "), "https://xn--fsqu00a.xn--0zwm56d/%E6%96%87%E6%A1%A3");
});

test("拒绝非 http(s) 协议、空值与带凭据的地址", async () => {
  const normalize = await load();
  for (const value of ["", "   ", null, undefined, 42]) assert.equal(normalize(value), null);
  for (const value of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,x", "chrome://settings", "mailto:a@b.c"]) {
    assert.equal(normalize(value), null, value);
  }
  assert.equal(normalize("https://user:pass@example.com/"), null);
});
