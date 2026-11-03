// 仅在用户明确授权真实模型验收后手动运行；不加入 npm test。
const { app } = require("electron");
const fs = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const assert = require("node:assert/strict");
const { loadEnvFile } = require("node:process");

app.on("window-all-closed", () => {});

async function main() {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pi-live-acceptance-"));
  app.setPath("userData", temporary);
  await app.whenReady();
  const report = { status: "blocked", steps: [] };
  let session;
  try {
    try { loadEnvFile(path.resolve(__dirname, "../.env")); } catch (error) { if (error.code !== "ENOENT") throw error; }
    const { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import("@mariozechner/pi-coding-agent");
    const { createChatService } = require("../src/main/services/chat-service.js");
    const cwd = path.join(temporary, "workspace"), agentDir = path.join(temporary, "agent");
    await fs.mkdir(cwd);
    await fs.mkdir(agentDir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    // 只在进程内读取 .env 认证，用官方配置登记临时供应商，不写入真实密钥或读取个人配置。
    const { readModelConfig } = require("../src/main/config/model-config.js");
    const startup = readModelConfig();
    const sourceRuntime = await ModelRuntime.create();
    const source = sourceRuntime.getModel(startup.provider, startup.modelId);
    assert.ok(source, "未找到 .env 模型");
    const auth = await sourceRuntime.getAuth(source);
    assert.ok(auth?.auth.apiKey, "未找到 .env 认证");
    process.env.PI_ACCEPTANCE_KEY = auth.auth.apiKey;
    const definition = {};
    for (const field of ["id", "name", "api", "reasoning", "input", "cost", "contextWindow", "maxTokens", "compat", "thinkingLevelMap"]) {
      if (source[field] !== undefined) definition[field] = source[field];
    }
    await fs.writeFile(path.join(agentDir, "models.json"), JSON.stringify({ providers: {
      "acceptance-custom": { api: source.api, baseUrl: startup.baseUrl || source.baseUrl, apiKey: "$PI_ACCEPTANCE_KEY", models: [definition] },
    } }));
    const runtime = await ModelRuntime.create();
    const model = runtime.getModel("acceptance-custom", source.id);
    report.model = { provider: model.provider, id: model.id, selection: "temporary-models.json" };
    const skillFile = path.join(cwd, "SKILL.md");
    await fs.writeFile(skillFile, "---\nname: acceptance-files\ndescription: 本次临时文件验收步骤\n---\n在当前目录使用 write 新建 evidence.txt，内容为 alpha；使用 edit 把 alpha 改为 beta；使用 bash 执行 cat evidence.txt 检查，最后简短回复完成。\n");
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
      noPromptTemplates: true, noContextFiles: true,
      systemPrompt: "你正在临时目录进行经用户授权的验收。只操作当前目录，严格按要求调用原生工具，简短回答。",
      skillsOverride: () => ({ skills: [{ name: "acceptance-files", description: "临时文件验收", filePath: skillFile, baseDir: cwd, source: "temporary" }], diagnostics: [] }),
    });
    await resourceLoader.reload();
    ({ session } = await createAgentSession({ cwd, agentDir, modelRuntime: runtime,
      model: { ...model, maxTokens: Math.min(model.maxTokens, 2048) }, thinkingLevel: "off",
      settingsManager, resourceLoader, sessionManager: SessionManager.create(cwd, path.join(temporary, "sessions")),
    }));
    await session.bindExtensions({ mode: "json" });
    const chat = createChatService({ getSession: async () => session });
    async function turn(name, prompt, stopAtTool = false) {
      report.phase = name;
      let deltas = 0, text = "", stopped = false, stopTimer;
      const tools = [];
      let timedOut = false;
      const timeout = setTimeout(() => { timedOut = true; void chat.stop(); }, 60000);
      const start = Date.now();
      try {
        const outcome = await chat.send(prompt, delta => { deltas++; text += delta; }, event => {
          if (event.type === "start") {
            tools.push(event.name);
            if (stopAtTool && event.name === "bash") stopTimer = setTimeout(() => { stopped = true; void chat.stop(); }, 750);
          }
        });
        assert.equal(timedOut, false, "请求超时");
        assert.equal(outcome.stopped, stopped);
        const result = { name, deltas, tools, stopped, elapsedMs: Date.now() - start };
        report.steps.push(result);
        console.log(JSON.stringify(result));
        return { ...result, text };
      } finally { clearTimeout(timeout); clearTimeout(stopTimer); }
    }
    if (!process.argv.includes("--stop-only")) {
      const reply = await turn("streaming-reply", "请只回复 PI_LIVE_OK。");
      assert.ok(reply.deltas > 0 && reply.text.includes("PI_LIVE_OK"));
      const files = await turn("skill-and-native-tools", "请完成临时文件验收：选择适用技能，先用 read 读取其 SKILL.md，再按技能步骤完成。必须依次使用 read、write、edit、bash，不使用其它工具代替。");
      for (const name of ["read", "write", "edit", "bash"]) assert.ok(files.tools.includes(name), `缺少 ${name} 工具证据`);
      assert.equal((await fs.readFile(path.join(cwd, "evidence.txt"), "utf8")).trim(), "beta");
    }
    const stopped = await turn("stop-running-tool", "请只用 bash 执行 node -e \"require('fs').writeFileSync('wait.pid',String(process.pid));setTimeout(()=>{},15000)\"。这是临时等待测试，不要添加后台执行或其它命令。", true);
    assert.ok(stopped.stopped && stopped.elapsedMs < 15000 && !session.isStreaming);
    const pid = Number(await fs.readFile(path.join(cwd, "wait.pid"), "utf8"));
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    report.status = "passed";
  } catch (error) {
    // 不打印供应商原始异常，避免请求头、地址或令牌进入日志。
    report.errorType = error.name;
    process.exitCode = 1;
  } finally {
    await session?.abort();
    session?.dispose();
    delete process.env.PI_ACCEPTANCE_KEY;
    if (process.env.PI_ACCEPTANCE_REPORT) await fs.writeFile(process.env.PI_ACCEPTANCE_REPORT, JSON.stringify(report, null, 2) + "\n");
    console.log(JSON.stringify(report));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}
main().then(() => app.exit(process.exitCode || 0)).catch(() => { console.error("真实验收初始化失败，未记录私密异常。"); app.exit(1); });
