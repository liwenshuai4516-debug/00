const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const { execFile } = require("node:child_process");
const { promisify } = require("node:util");

test("官方 runtime 的扩展命令新建、分叉、切换、树导航、withSession 与重载均不请求模型", async t => {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pi-desktop-runtime-")));
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.mkdir(path.join(base, "workspace"));
  await fs.mkdir(path.join(base, "agent/extensions"), { recursive: true });
  await fs.writeFile(path.join(base, "agent/extensions/desktop.js"), `export default function(pi) {
    pi.on("session_start", (_event, ctx) => { ctx.ui.setStatus("desktop", "ready"); });
    pi.registerCommand("desktop-new", { handler: async (_args, ctx) => {
      if (!await ctx.ui.confirm("确认", "新建")) return;
      await ctx.newSession({ setup: async manager => manager.appendCustomEntry("seed", { value: 1 }),
        withSession: async fresh => fresh.sendMessage({ customType: "desktop-message", content: "新会话扩展消息", display: true }) });
    }});
    pi.registerCommand("desktop-fork", { handler: async (entry, ctx) => { await ctx.fork(entry, { position: "at" }); } });
    pi.registerCommand("desktop-switch", { handler: async (file, ctx) => { await ctx.switchSession(file); } });
    pi.registerCommand("desktop-tree", { handler: async (entry, ctx) => { await ctx.navigateTree(entry); } });
    pi.registerCommand("desktop-setup-fail", { handler: async (_args, ctx) => { await ctx.newSession({ setup: async () => { throw new Error("setup failed"); } }); } });
    pi.registerCommand("desktop-ui", { handler: async (_args, ctx) => {
      if (ctx.mode !== "rpc" || !ctx.hasUI) throw new Error("错误的宿主能力");
      const selected = await ctx.ui.select("选项", ["A", "B"]);
      const text = await ctx.ui.input("输入");
      const edited = await ctx.ui.editor("编辑", text);
      ctx.ui.setWidget("result", [selected, edited], { placement: "belowEditor" });
      ctx.ui.setEditorText("待发送建议"); ctx.ui.notify("完成");
    }});
  }`);
  const root = path.resolve(__dirname, "../..");
  const script = `
    const assert = require("node:assert/strict"), path = require("node:path");
    const { createSessionService } = require(${JSON.stringify(root + "/src/main/services/session-service.js")});
    const { createSessionStateStore } = require(${JSON.stringify(root + "/src/main/storage/session-state-store.js")});
    const { closePiSession } = require(${JSON.stringify(root + "/src/main/resources/pi-session-lifecycle.js")});
    globalThis.fetch = async () => assert.fail("不得请求模型");
    async function run() {
      const { createPiAgent, sendMessage } = await import(${JSON.stringify(root + "/src/main/pi-agent.mjs")});
      const base = process.argv[1], workspace = path.join(base, "workspace");
      const events = [], statuses = [];
      const opts = { createUiContext: (_session, base) => ({ ...base,
        select: async () => "B", confirm: async () => true, input: async () => "用户输入", editor: async (_title, text) => text + "已编辑",
        setStatus: (...args) => statuses.push(args), setWidget: (...args) => events.push(args),
        setEditorText: text => events.push(text), notify: text => events.push(text),
      }) };
      const model = { provider: "openai", modelId: "gpt-4", baseUrl: "https://example.invalid/v1" };
      const service = createSessionService(path.join(base, "sessions"), (dir, resume, file, cwd) => createPiAgent(dir, resume, file, cwd, model, undefined, undefined, undefined, opts), () => workspace, async () => {}, createSessionStateStore(path.join(base, "state")));
      const original = await service.getSession();
      original.sessionManager.appendMessage({ role: "user", content: "仅本地历史", timestamp: Date.now() });
      const oldPath = original.sessionFile;
      const streamed = [];
      await sendMessage(original, "/desktop-new", () => {}, event => streamed.push(event));
      const next = await service.getSession();
      assert.notEqual(next.sessionId, original.sessionId);
      assert.equal(next.desktopRuntime, original.desktopRuntime);
      assert.ok(next.sessionManager.getEntries().some(item => item.customType === "seed"));
      assert.ok(streamed.some(item => item.type === "message" && item.text === "新会话扩展消息"));
      assert.ok((await service.loadHistory()).some(item => item.text === "新会话扩展消息"));
      await sendMessage(next, "/desktop-ui", () => {}, () => {});
      assert.ok(events.includes("待发送建议"));
      assert.ok(events.some(item => Array.isArray(item) && item[0] === "result" && item[1][1] === "用户输入已编辑"));
      next.sessionManager.appendMessage({ role: "user", content: "分叉目标", timestamp: Date.now() });
      const entry = next.sessionManager.getLeafId();
      await sendMessage(next, "/desktop-fork " + entry, () => {}, () => {});
      const forked = await service.getSession();
      assert.notEqual(forked.sessionId, next.sessionId);
      assert.equal(forked.sessionManager.getCwd(), workspace);
      await sendMessage(forked, "/desktop-tree " + forked.sessionManager.getLeafId(), () => {}, () => {});
      assert.equal(forked.desktopHistoryChanged, true);
      await sendMessage(forked, "/desktop-switch " + oldPath, () => {}, () => {});
      assert.equal((await service.getSession()).sessionId, original.sessionId);
      const final = await service.getSession();
      const { createChatService } = require(${JSON.stringify(root + "/src/main/services/chat-service.js")});
      const chat = createChatService(service, async () => sendMessage);
      const result = await chat.send("/reload", () => assert.fail("重载不应生成回复"), () => {});
      assert.equal(result.completionStatus, "Pi 资源已重新加载。");
      assert.equal(result.stopped, false);
      assert.ok(statuses.length >= 4);
      await sendMessage(final, "/desktop-setup-fail", () => {}, () => {});
      assert.ok(final.desktopResourceDiagnostics.some(item => item.message.includes("setup failed")));
      const adopted = await service.getSession();
      assert.notEqual(adopted.sessionId, final.sessionId);
      assert.equal(adopted.desktopRuntime.session, adopted);
      await sendMessage(adopted, "/desktop-ui", () => {}, () => {});
      const { bindDesktopRuntime } = await import(${JSON.stringify(root + "/src/main/resources/desktop-session-runtime.mjs")});
      await bindDesktopRuntime(adopted, async () => { throw new Error("factory failed"); }, opts);
      await sendMessage(adopted, "/desktop-new", () => {}, () => {});
      assert.ok(adopted.desktopResourceDiagnostics.some(item => item.message.includes("原会话已释放")));
      await assert.rejects(sendMessage(adopted, "/desktop-ui", () => {}, () => {}), /当前 Pi 会话已释放/);
      await closePiSession(adopted);
    }
    run().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await promisify(execFile)(process.execPath, ["-e", script, base], {
    env: { ...process.env, PI_CODING_AGENT_DIR: path.join(base, "agent") },
  });
  assert.equal(result.stderr, "");
});
