const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createOAuthFlowManager } = require("../../src/main/model/oauth-flow.js");

test("OAuth 提示、重复启动、恢复状态、回复和结果事件", async () => {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const events = [];
  const manager = createOAuthFlowManager(async () => ({
    getProvider: () => ({ auth: { oauth: {} } }),
    async login(_provider, type, interaction) {
      assert.equal(type, "oauth");
      interaction.notify({ type: "auth_url", url: "https://example.invalid/login", instructions: "登录" });
      const reply = await interaction.prompt({ type: "select", message: "账号", options: [{ id: "a", label: "A" }] });
      assert.equal(reply, "a");
    },
  }));
  manager.subscribe(event => { events.push(event); if (event.status === "success") finish(); });
  const flow = await manager.start("provider");
  assert.equal((await manager.start("provider")).id, flow.id);
  const recovered = manager.list()[0];
  assert.equal(recovered.prompt.type, "select");
  assert.throws(() => manager.reply(flow.id, recovered.prompt.id, "missing"), /有效选项/);
  manager.reply(flow.id, recovered.prompt.id, "a");
  await completed;
  assert.equal(manager.list()[0].status, "success");
  assert.equal(events.at(-1).prompt, undefined);
});

test("OAuth 取消等待中的提示，过期回复拒绝，错误不输出令牌", async () => {
  let finish;
  const completed = new Promise(resolve => { finish = resolve; });
  const manager = createOAuthFlowManager(async () => ({
    getProvider: () => ({ auth: { oauth: {} } }),
    async login(_provider, _type, interaction) { await interaction.prompt({ type: "secret", message: "输入" }); },
  }));
  manager.subscribe(event => { if (event.status === "cancelled") finish(); });
  const flow = await manager.start("provider");
  manager.cancel(flow.id); await completed;
  assert.equal(manager.list()[0].status, "cancelled");
  assert.throws(() => manager.reply(flow.id, "old", "secret"), /失效/);
  const failing = createOAuthFlowManager(async () => ({ getProvider: () => ({ auth: { oauth: {} } }), login: async () => { throw new Error("private-token"); } }));
  await failing.start("provider"); await new Promise(resolve => setImmediate(resolve));
  assert.equal(JSON.stringify(failing.list()).includes("private-token"), false);
});
