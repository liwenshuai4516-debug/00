const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isBrowserUrl } = require("../../src/main/services/guest-browser-policy.js");

test("侧栏浏览器只接受 http(s) 主文档", () => {
  assert.equal(isBrowserUrl("https://example.com/"), true);
  assert.equal(isBrowserUrl("http://127.0.0.1:3000/a"), true);
  for (const value of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x", "about:blank", "", "not a url", null]) {
    assert.equal(isBrowserUrl(value), false, String(value));
  }
});
