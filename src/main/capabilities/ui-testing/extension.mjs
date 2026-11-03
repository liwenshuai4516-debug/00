import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile, readFile } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { openLogin } from "./login-session.mjs";
import { Type } from "typebox";

const serverName = "desktop-playwright-test";
const toolPrefix = "mcp__desktop_playwright_test__";

function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function createUiTestingExtension(runtime) {
  return (pi) => {
    let activeRecordingDir = null;
    const logins = new Map();
    const result = (details) => ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details });
    const target = (value) => {
      const url = new URL(value);
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
        throw new Error("页面地址必须使用 HTTP/HTTPS，且不能包含账号或密码。");
      }
      return url;
    };

    pi.on("session_shutdown", async () => {
      const outcomes = await Promise.allSettled([...logins].map(async ([id, entry]) => {
        await entry.cleanup();
        logins.delete(id);
      }));
      const failed = outcomes.filter((outcome) => outcome.status === "rejected");
      if (failed.length) throw new Error(`${failed.length} 个登录态未完成清理。`);
    });

    pi.registerTool({
      name: "qa_ui_login",
      label: "可见窗口登录与清理",
      description: "start 打开独立可见窗口供用户手动登录；complete 经用户确认保存本次私有登录态；cancel 关闭窗口并删除登录态。禁止索取密码。",
      executionMode: "sequential",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("start"), Type.Literal("complete"), Type.Literal("cancel")]),
        targetUrl: Type.Optional(Type.String()),
        loginId: Type.Optional(Type.String()),
      }),
      async execute(_id, params, signal, _update, ctx) {
        if (params.action === "start") {
          if (!ctx.hasUI) throw new Error("手动登录需要可见桌面交互。");
          target(params.targetUrl);
          const entry = await openLogin(runtime, params.targetUrl, signal);
          const loginId = randomUUID();
          logins.set(loginId, entry);
          return result({ loginId, status: "open", message: "请在可见窗口手动登录，完成后调用 complete。登录过程不录制。" });
        }
        const entry = logins.get(params.loginId);
        if (!entry) throw new Error("登录交接已失效，请重新登录。");
        if (params.action === "cancel") {
          await entry.cleanup();
          logins.delete(params.loginId);
          return result({ loginId: params.loginId, status: "deleted" });
        }
        if (entry.status !== "open") throw new Error("登录态已交接，不能重复保存。");
        if (!ctx.hasUI || !await ctx.ui.confirm("本次 UI 测试登录态", "是否将当前登录态保存到本机私有临时文件，用于本次录制及一个回放批次，并在回放结束或会话关闭时删除？", { signal })) {
          await entry.cleanup();
          logins.delete(params.loginId);
          return result({ status: "cancelled", cleanup: "deleted" });
        }
        try {
          await entry.save(signal);
        } catch (error) {
          await entry.cleanup();
          logins.delete(params.loginId);
          throw error;
        }
        return result({ loginId: params.loginId, status: "saved", origin: entry.origin, message: "已私有保存；实际身份与权限仍须在用例前置检查中验证。" });
      },
    });

    // 使用官方资源发现事件提供随客户端分发的技能。
    pi.on("resources_discover", () => ({
      skillPaths: [runtime.skill],
    }));

    // 保存官方生成日志原文，不自行制造录制步骤。
    pi.on("tool_result", async (event) => {
      if (
        !activeRecordingDir ||
        event.toolName !== `${toolPrefix}generator_read_log`
      ) {
        return;
      }

      const file = path.join(
        activeRecordingDir,
        `generator-log-${randomUUID()}.json`,
      );

      await writeFile(file, JSON.stringify({
        toolCallId: event.toolCallId,
        content: event.content,
        isError: event.isError,
      }, null, 2) + "\n", { flag: "wx" });

      return {
        content: [
          ...event.content,
          { type: "text", text: `官方生成日志已保存：${file}` },
        ],
      };
    });

    pi.registerTool({
      name: "qa_ui_prepare",
      label: "准备 UI 测试",
      description:
        "检查客户端内置运行环境，准备 UI 录制或多个已有 case 的独立回放批次，并自动生成摘要、版本及证据清单。",
      promptSnippet: "准备 UI 录制或已有 case 的测试运行环境。",
      executionMode: "sequential",
      parameters: Type.Object({
        caseId: Type.Optional(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" })),
        caseIds: Type.Optional(Type.Array(Type.String({ pattern: "^[a-z][a-z0-9-]{0,63}$" }), { minItems: 1, maxItems: 100 })),
        loginId: Type.Optional(Type.String()),
        headed: Type.Optional(Type.Boolean()),
        targetUrl: Type.String(),
        mode: Type.Optional(Type.Union([
          Type.Literal("record"),
          Type.Literal("run"),
        ])),
      }),

      async execute(_id, params, signal, _update, ctx) {
        const mode = params.mode ?? "record";
        const parsedUrl = target(params.targetUrl);
        const caseIds = params.caseIds ?? (params.caseId ? [params.caseId] : []);
        if (!caseIds.length || new Set(caseIds).size !== caseIds.length ||
          caseIds.some((id) => !/^[a-z][a-z0-9-]{0,63}$/.test(id)) ||
          (params.caseIds && params.caseId) || (mode === "record" && caseIds.length !== 1)) {
          throw new Error("录制提供一个 caseId；回放提供 caseId 或不重复的 caseIds。");
        }
        const caseId = caseIds[0];
        const login = params.loginId ? logins.get(params.loginId) : null;
        if (params.loginId && (!login || login.status !== "saved" || !existsSync(login.file) || login.origin !== parsedUrl.origin)) {
          throw new Error("登录态已失效、已绑定批次或与目标站点不符，请重新登录。");
        }

        for (const key of ["node", "testCli", "config", "verify", "skill", "runner", "login"]) {
          if (!existsSync(runtime[key])) {
            throw new Error(`客户端测试运行环境缺失：${runtime[key]}`);
          }
        }

        const workspace = await realpath(ctx.cwd);

        // 复用官方执行接口，保留取消及超时语义。
        const checked = await pi.exec(
          runtime.node,
          [runtime.verify],
          { cwd: workspace, signal, timeout: 30_000 },
        );

        if (checked.killed || checked.code !== 0) {
          throw new Error(
            `测试运行环境检查未通过：${checked.stderr || checked.stdout}`,
          );
        }

        signal?.throwIfAborted();

        const caseDir = path.join(workspace, "qa/ui/cases");
        const caseFile = path.join(caseDir, `${caseId}.spec.cjs`);
        const caseFiles = caseIds.map((id) => path.join(caseDir, `${id}.spec.cjs`));
        const seedFile = path.join(caseDir, `${caseId}.seed.spec.cjs`);

        if (
          mode === "record" &&
          [
            caseFile,
            seedFile,
            path.join(caseDir, `${caseId}.md`),
          ].some((file) => existsSync(file))
        ) {
          throw new Error("同名 case 已存在，请换 caseId；复跑请使用 run 模式。");
        }

        if (mode === "run" && caseFiles.some((file) => !existsSync(file))) {
          throw new Error("批次中存在未找到的 case。");
        }

        const runId = `${caseId}-${randomUUID()}`;
        const runDir = path.join(workspace, "qa/ui/runs", runId);
        const recordingDir = path.join(
          workspace,
          "qa/ui/recordings",
          runId,
        );

        await mkdir(caseDir, { recursive: true });
        await mkdir(runDir, { recursive: true });

        const commonEnv = {
          NODE_PATH: runtime.modules,
          PLAYWRIGHT_BROWSERS_PATH: runtime.browsers,
          QA_TARGET_URL: params.targetUrl,
          QA_UI_CASES_DIR: caseDir,
          QA_UI_STORAGE_STATE: login?.file ?? "",
          QA_UI_HEADED: params.headed ? "1" : "0",
        };

        if (mode === "record") {
          await mkdir(recordingDir, { recursive: true });

          await writeFile(seedFile, [
            'const { test } = require("@playwright/test");',
            "",
            'test("seed", async ({ page }) => {',
            "  await page.goto(process.env.QA_TARGET_URL);",
            "});",
            "",
          ].join("\n"), { flag: "wx" });

          activeRecordingDir = recordingDir;

          // MCP 连接、工具登记、取消及会话关闭由 Pi 官方实现负责。
          pi.registerMcpServer(serverName, {
            command: runtime.node,
            args: [
              runtime.testCli,
              "run-test-mcp-server",
              ...(params.headed ? [] : ["--headless"]),
              "-c",
              runtime.config,
            ],
            cwd: workspace,
            env: {
              ...commonEnv,
              QA_UI_PHASE: "record",
              QA_UI_OUTPUT_DIR: recordingDir,
            },
            exposure: "direct",
            timeout: 90,
            description: "官方 Playwright Test 页面操作、录制和测试生成工具。",
          });
        }

        if (mode === "run") {
          pi.unregisterMcpServer(serverName);
          activeRecordingDir = null;
        }
        const taskFile = path.join(runDir, "task.json");
        const replayCommand = mode === "run"
          ? [quote(runtime.node), quote(runtime.runner), quote(taskFile)].join(" ")
          : null;
        const caseHashes = {};
        if (mode === "run") {
          for (const file of caseFiles) {
            caseHashes[file] = createHash("sha256").update(await readFile(file)).digest("hex");
          }
        }

        const prepared = {
          status: "prepared",
          mode,
          caseId,
          caseIds,
          caseFiles,
          caseHashes,
          workspace,
          caseDir,
          config: runtime.config,
          testCli: runtime.testCli,
          modules: runtime.modules,
          browsers: runtime.browsers,
          targetUrl: params.targetUrl,
          runId,
          caseFile,
          // 官方 generator_write_test 仅接受相对于 MCP 工作目录的路径。
          caseFileName: path.relative(workspace, caseFile).split(path.sep).join("/"),
          caseDocument: path.join(caseDir, `${caseId}.md`),
          seedFile: mode === "record" ? seedFile : null,
          recordingDir: mode === "record" ? recordingDir : null,
          runDir,
          resultsFile: path.join(runDir, "results.json"),
          htmlReport: path.join(runDir, "html/index.html"),
          replayCommand,
          summaryFile: path.join(runDir, "summary.json"),
          summaryDocument: path.join(runDir, "summary.md"),
          manifestFile: path.join(runDir, "manifest.json"),
        };

        await writeFile(
          path.join(runDir, "task.json"),
          JSON.stringify({ ...prepared, authFile: mode === "run" ? login?.file : undefined, authDirectory: mode === "run" ? login?.directory : undefined }, null, 2) + "\n",
          { flag: "wx" },
        );

        if (login && mode === "run") login.status = "bound";

        return {
          content: [{
            type: "text",
            text: JSON.stringify(prepared, null, 2),
          }],
          details: prepared,
        };
      },
    });
  };
}
