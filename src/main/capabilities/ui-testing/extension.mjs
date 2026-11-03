import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

const serverName = "desktop-playwright-test";
const toolPrefix = "mcp__desktop_playwright_test__";

function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

export function createUiTestingExtension(runtime) {
  return (pi) => {
    let activeRecordingDir = null;

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
        "检查客户端内置运行环境，准备单个 UI case，并登记官方 Playwright Test MCP。run 模式仅准备已有 case 的回放。",
      promptSnippet: "准备 UI 录制或已有 case 的测试运行环境。",
      executionMode: "sequential",
      parameters: Type.Object({
        caseId: Type.String({
          pattern: "^[a-z][a-z0-9-]{0,63}$",
        }),
        targetUrl: Type.String(),
        mode: Type.Optional(Type.Union([
          Type.Literal("record"),
          Type.Literal("run"),
        ])),
      }),

      async execute(_id, params, signal, _update, ctx) {
        const mode = params.mode ?? "record";
        const parsedUrl = new URL(params.targetUrl);

        if (!["http:", "https:"].includes(parsedUrl.protocol)) {
          throw new Error("页面地址必须使用 HTTP 或 HTTPS。");
        }

        for (const key of ["node", "testCli", "config", "verify", "skill"]) {
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
        const caseFile = path.join(caseDir, `${params.caseId}.spec.cjs`);
        const seedFile = path.join(caseDir, `${params.caseId}.seed.spec.cjs`);

        if (
          mode === "record" &&
          [
            caseFile,
            seedFile,
            path.join(caseDir, `${params.caseId}.md`),
          ].some((file) => existsSync(file))
        ) {
          throw new Error("同名 case 已存在，请换 caseId；复跑请使用 run 模式。");
        }

        if (mode === "run" && !existsSync(caseFile)) {
          throw new Error(`未找到可回放的 case：${caseFile}`);
        }

        const runId = `${params.caseId}-${randomUUID()}`;
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
              "--headless",
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

        const runEnv = {
          ...commonEnv,
          QA_UI_PHASE: "run",
          QA_UI_OUTPUT_DIR: runDir,
        };

        const filter = `qa/ui/cases/${params.caseId}\\.spec\\.cjs$`;

        const replayCommand = [
          ...Object.entries(runEnv).map(
            ([key, value]) => `${key}=${quote(value)}`,
          ),
          quote(runtime.node),
          quote(runtime.testCli),
          "test",
          quote(filter),
          "--config",
          quote(runtime.config),
          "--project=chromium",
        ].join(" ");

        const prepared = {
          status: "prepared",
          mode,
          caseId: params.caseId,
          targetUrl: params.targetUrl,
          runId,
          caseFile,
          // 官方 generator_write_test 仅接受相对于 MCP 工作目录的路径。
          caseFileName: path.relative(workspace, caseFile).split(path.sep).join("/"),
          caseDocument: path.join(caseDir, `${params.caseId}.md`),
          seedFile: mode === "record" ? seedFile : null,
          recordingDir: mode === "record" ? recordingDir : null,
          runDir,
          resultsFile: path.join(runDir, "results.json"),
          htmlReport: path.join(runDir, "html/index.html"),
          replayCommand,
        };

        await writeFile(
          path.join(runDir, "task.json"),
          JSON.stringify(prepared, null, 2) + "\n",
          { flag: "wx" },
        );

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
