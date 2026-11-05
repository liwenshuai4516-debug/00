import path from "node:path";
import { existsSync } from "node:fs";
import { mkdir, realpath, writeFile, readFile, readdir } from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { openLogin } from "./login-session.mjs";
import { resolveProject, readCredentials } from "./project-context.mjs";
import { Type } from "typebox";

const serverName = "desktop-playwright-test";
const toolPrefix = "mcp__desktop_playwright_test__";

function quote(value) {
  return "'" + String(value).replaceAll("'", "'\"'\"'") + "'";
}

const caseDocumentSchema = "qa-ui-case/v1";
const caseTypes = new Set(["functional", "permission", "boundary", "exception", "regression"]);
const casePriorities = new Set(["P0", "P1", "P2", "P3"]);
const caseDataPolicies = new Set(["read-only", "write-unique", "write-disposable", "no-write"]);
const assertionKinds = new Set(["business", "guard"]);
const modulePathMaxDepth = 6;
const modulePathSegmentMax = 60;
const hasText = (value) => typeof value === "string" && value.trim().length > 0;

// 用例说明同时是人读文档和后续分类的索引来源，登记前固定字段与取值，避免只有自然语言。
function parseCaseMetadata(document, project, caseId) {
  const block = document.match(/```json qa-ui-case[ \t]*\r?\n([\s\S]*?)\r?\n```/);
  if (!block) throw new Error("用例说明缺少标准元数据块（```json qa-ui-case ... ```），模板见 qa-ui-record。");
  let meta;
  try {
    meta = JSON.parse(block[1]);
  } catch {
    throw new Error("用例说明的 qa-ui-case 元数据不是有效 JSON。");
  }
  if (meta?.schema !== caseDocumentSchema) throw new Error(`用例说明 schema 必须是 ${caseDocumentSchema}。`);
  if (meta.caseId !== caseId) throw new Error("用例说明 caseId 与本次录制不一致。");
  if (meta?.project?.id !== project.projectId) throw new Error("用例说明 project.id 与项目检查结果不一致。");
  if (!hasText(meta.page) || !hasText(meta.role)) throw new Error("用例说明 page 和 role 不能为空。");
  if (!caseDataPolicies.has(meta.dataPolicy)) throw new Error("用例说明 dataPolicy 必须是 read-only、write-unique、write-disposable 或 no-write。");
  if (meta.tags !== undefined && (!Array.isArray(meta.tags) || meta.tags.some((tag) => !hasText(tag)))) {
    throw new Error("用例说明 tags 必须是非空字符串数组。");
  }
  if (meta.modulePath !== undefined) {
    if (
      !Array.isArray(meta.modulePath) ||
      meta.modulePath.length < 1 ||
      meta.modulePath.length > modulePathMaxDepth ||
      meta.modulePath.some(
        (segment) =>
          !hasText(segment) ||
          segment.trim().length > modulePathSegmentMax ||
          segment.includes("/"),
      )
    ) {
      throw new Error(`用例说明 modulePath 必须是 1-${modulePathMaxDepth} 段非空字符串，每段不超过 ${modulePathSegmentMax} 字且不含 /。`);
    }
  }
  if (!Array.isArray(meta.cases) || !meta.cases.length) throw new Error("用例说明必须包含至少一个 case。");
  const names = new Set();
  for (const [caseIndex, item] of meta.cases.entries()) {
    const label = `cases[${caseIndex}]`;
    if (!hasText(item?.name)) throw new Error(`${label}.name 不能为空。`);
    if (names.has(item.name)) throw new Error(`用例名称重复：${item.name}。`);
    names.add(item.name);
    if (!caseTypes.has(item.type)) throw new Error(`${label}.type 必须是 functional、permission、boundary、exception 或 regression。`);
    if (!casePriorities.has(item.priority)) throw new Error(`${label}.priority 必须是 P0、P1、P2 或 P3。`);
    if (!Array.isArray(item.steps) || item.steps.length < 1 || item.steps.length > 50) {
      throw new Error(`${label}.steps 必须是 1-50 条非空执行步骤。`);
    }
    for (const [stepIndex, step] of item.steps.entries()) {
      if (!hasText(step) || step.trim().length > 500) {
        throw new Error(`${label}.steps[${stepIndex}] 必须是非空字符串且不超过 500 字。`);
      }
    }
    if (!Array.isArray(item.assertions) || !item.assertions.length) throw new Error(`${label} 至少包含一条断言。`);
    for (const [assertionIndex, assertion] of item.assertions.entries()) {
      const assertionLabel = `${label}.assertions[${assertionIndex}]`;
      if (!hasText(assertion?.text)) throw new Error(`${assertionLabel}.text 不能为空。`);
      if (!hasText(assertion?.source)) throw new Error(`${assertionLabel}.source 不能为空。`);
      if (assertion.kind !== undefined && !assertionKinds.has(assertion.kind)) {
        throw new Error(`${assertionLabel}.kind 必须是 business 或 guard。`);
      }
    }
  }
  return {
    schema: meta.schema,
    caseId,
    project: { id: project.projectId, name: hasText(meta.project.name) ? meta.project.name : project.projectName },
    page: meta.page,
    role: meta.role,
    dataPolicy: meta.dataPolicy,
    modulePath: meta.modulePath?.map((segment) => segment.trim()) ?? undefined,
    tags: meta.tags ?? [],
    cases: meta.cases,
    caseCount: meta.cases.length,
    assertionCount: meta.cases.reduce((total, item) => total + item.assertions.length, 0),
  };
}

export function createUiTestingExtension(runtime) {
  return (pi) => {
    let activeRecordingDir = null;
    const result = (details) => ({ content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details });
    const logins = new Map();
    const projects = new Map();
    async function boundProject(projectRef, ctx) {
      const project = projects.get(projectRef);
      if (!project || project.workspace !== await realpath(ctx.cwd)) {
        throw new Error("项目检查已失效或工作区已切换，请重新调用 qa_ui_project。");
      }
      if (await realpath(project.caseDir) !== project.caseDir) throw new Error("测试数据目录已改变，请重新检查工作区。");
      return project;
    }
    pi.registerTool({
      name: "qa_ui_project",
      label: "检查 UI 项目与测试数据目录",
      description: "按当前会话工作区检查 qa/data，按地址匹配已登记项目。只返回项目名称、地址及配置完整性，不返回账号密码。",
      executionMode: "sequential",
      parameters: Type.Object({
        targetUrl: Type.String(),
        projectId: Type.Optional(Type.String()),
        projectName: Type.Optional(Type.String()),
        expectedWorkspaceRoot: Type.Optional(Type.String()),
      }),
      async execute(_id, params, signal, _update, ctx) {
        signal?.throwIfAborted();
        const project = await resolveProject(runtime, params, ctx.cwd);
        const projectRef = randomUUID();
        projects.set(projectRef, { ...project, loginChecked: false, recordings: new Map() });
        return result({ status: "ready", projectRef, ...project });
      },
    });
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
      description: "auto 根据 projectRef 由后端读取已配置凭据，判断登录需要并尝试一次自动登录；仅验证码等异常返回人工处理。start/complete 为手动方式，complete 默认保存私有临时登录态，cancel 清理。凭据不返回模型。",
      executionMode: "sequential",
      parameters: Type.Object({
        action: Type.Union([Type.Literal("auto"), Type.Literal("start"), Type.Literal("complete"), Type.Literal("cancel")]),
        projectRef: Type.Optional(Type.String()),
        selectors: Type.Optional(Type.Object({
          account: Type.Optional(Type.String()), password: Type.Optional(Type.String()),
          submit: Type.Optional(Type.String()), authenticated: Type.Optional(Type.String()),
        })),
        targetUrl: Type.Optional(Type.String()),
        loginId: Type.Optional(Type.String()),
        headed: Type.Optional(Type.Boolean()),
      }),
      async execute(_id, params, signal, _update, ctx) {
        if (params.action === "auto") {
          const project = await boundProject(params.projectRef, ctx);
          if (project.autoLoginAttempted) throw new Error("本次项目已尝试自动登录，请处理现有窗口或重新检查项目，不能重复提交。");
          const credentials = await readCredentials(runtime, project);
          const entry = await openLogin(runtime, project.targetUrl, signal, { headed: params.headed === true });
          entry.projectRef = params.projectRef;
          project.autoLoginAttempted = true;
          const loginId = randomUUID();
          logins.set(loginId, entry);
          let outcome;
          try { outcome = await entry.auto(credentials, params.selectors, signal); }
          catch (error) {
            await entry.cleanup();
            logins.delete(loginId);
            throw error;
          }
          if (outcome.status === "not-required") {
            await entry.cleanup();
            logins.delete(loginId);
            project.loginChecked = true;
            project.loginId = null;
            return result({ status: "not-required", verification: outcome.verification, message: "目标页面可访问且未发现登录表单；录制前仍需检查角色与权限。" });
          }
          if (outcome.status === "saved") {
            project.loginChecked = true;
            project.loginId = loginId;
          }
          if (outcome.status === "manual-required" && params.headed !== true) {
            await entry.cleanup();
            logins.delete(loginId);
            return result({
              status: "manual-required",
              reason: `${outcome.reason} 默认静默登录不打开可见窗口；需要人工接管时传 headed=true，或使用 --storage-state。`,
              verification: outcome.verification,
            });
          }
          return result({ loginId, status: outcome.status, reason: outcome.reason, verification: outcome.verification });
        }
        if (params.action === "start") {
          if (!ctx.hasUI) throw new Error("手动登录需要可见桌面交互。");
          target(params.targetUrl);
          const project = params.projectRef ? await boundProject(params.projectRef, ctx) : null;
          if (project && target(params.targetUrl).href !== project.targetUrl) throw new Error("登录地址与项目检查结果不一致。");
          const entry = await openLogin(runtime, params.targetUrl, signal, { headed: true });
          entry.projectRef = params.projectRef;
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
        // UI 测试期间默认允许交接手动登录态；仍只写入 0600 临时目录，并按批次或会话关闭清理。
        try {
          await entry.save(signal);
        } catch (error) {
          await entry.cleanup();
          logins.delete(params.loginId);
          throw error;
        }
        if (entry.projectRef && projects.has(entry.projectRef)) {
          const project = await boundProject(entry.projectRef, ctx);
          project.loginChecked = true;
          project.loginId = params.loginId;
        }
        return result({ loginId: params.loginId, status: "saved", origin: entry.origin, message: "已私有保存；实际身份与权限仍须在用例前置检查中验证。" });
      },
    });


    pi.registerTool({
      name: "qa_ui_finalize",
      label: "登记格式整理后的 UI 脚本",
      description: "录制后由 Agent 根据真实日志整理脚本及断言，保存文档，再由此工具检查语法、证据和标准用例元数据并登记资产版本。此工具不推断业务正确性。",
      executionMode: "sequential",
      parameters: Type.Object({ projectRef: Type.String(), caseId: Type.String() }),
      async execute(_id, params, signal, _update, ctx) {
        const project = await boundProject(params.projectRef, ctx);
        const recorded = project.recordings.get(params.caseId);
        if (!recorded) throw new Error("未找到本次真实录制准备记录。");
        const logs = (await readdir(recorded.recordingDir)).filter((name) => /^generator-log-.*\.json$/.test(name));
        if (!logs.length) throw new Error("缺少官方生成日志，不能登记为已录制资产。");
        for (const name of logs) {
          const log = JSON.parse(await readFile(path.join(recorded.recordingDir, name), "utf8"));
          if (log.isError) throw new Error("生成日志存在错误，请先核对原始录制证据。");
        }
        const source = await readFile(recorded.caseFile);
        const document = await readFile(recorded.caseDocument, "utf8");
        if (!source.length || !document.trim()) throw new Error("脚本和用例说明不能为空。");
        const caseMeta = parseCaseMetadata(document, project, params.caseId);
        const credentials = await readCredentials(runtime, project);
        if (credentials.password && (
          source.includes(Buffer.from(credentials.password))
          || source.includes(Buffer.from(JSON.stringify(credentials.password)))
          || document.includes(credentials.password)
        )) {
          throw new Error("脚本或用例说明包含配置中的密码，请移除凭据后重新整理。");
        }
        const checked = await pi.exec(runtime.node, ["--check", recorded.caseFile], { cwd: project.workspace, signal, timeout: 30_000 });
        if (checked.killed || checked.code !== 0) throw new Error("脚本语法检查未通过，请检查脚本；不会自动回放。");
        const metadata = {
          projectId: project.projectId, projectName: project.projectName,
          targetUrl: project.targetUrl, caseId: params.caseId,
          sha256: createHash("sha256").update(source).digest("hex"),
          recordedAt: new Date().toISOString(),
          recordingLogs: logs.map((name) => path.join(recorded.recordingDir, name)),
          caseDocument: recorded.caseDocument,
          caseMeta,
          status: "recorded-and-syntax-checked",
        };
        const assetFile = path.join(project.caseDir, `${params.caseId}.asset.json`);
        await writeFile(assetFile, JSON.stringify(metadata, null, 2) + "\n");
        return result({ ...metadata, assetFile, message: "脚本已保存并完成语法和来源登记；业务结果由回放断言判断。" });
      },
    });

    // 使用官方资源发现事件提供随客户端分发的技能；报告技能与接口测试共用。
    pi.on("resources_discover", () => ({
      skillPaths: [runtime.skill, runtime.recordSkill, runtime.executeSkill, runtime.assertionSkill, runtime.reportSkill],
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
        "检查客户端内置运行环境，准备 UI 录制或多个已有 case 的独立回放批次，并自动生成摘要、版本及证据清单。录制模式成功返回后才会登记官方 Playwright 页面操作与脚本生成工具（browser_*/generator_*），准备前看不到它们属于正常状态。",
      promptSnippet: "准备 UI 录制或已有 case 的测试运行环境；录制工具由本工具登记。",
      executionMode: "sequential",
      parameters: Type.Object({
        caseId: Type.Optional(Type.String({ minLength: 1, maxLength: 180 })),
        caseIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 180 }), { minItems: 1, maxItems: 100 })),
        loginId: Type.Optional(Type.String()),
        headed: Type.Optional(Type.Boolean()),
        projectRef: Type.Optional(Type.String()),
        targetUrl: Type.String(),
        mode: Type.Optional(Type.Union([
          Type.Literal("record"),
          Type.Literal("run"),
        ])),
      }),

      async execute(_id, params, signal, _update, ctx) {
        const mode = params.mode ?? "record";
        const parsedUrl = target(params.targetUrl);
        const project = params.projectRef ? await boundProject(params.projectRef, ctx) : null;
        if (project && target(params.targetUrl).href !== project.targetUrl) throw new Error("输入地址与项目检查结果不一致，请重新检查。");
        if (project && !project.loginChecked) throw new Error("请先通过 qa_ui_login 判断并处理登录。");
        let defaultCaseId = project?.assetName;
        if (project && mode === "record" && !params.caseId && [".spec.cjs", ".seed.spec.cjs", ".md"].some((suffix) => existsSync(path.join(project.caseDir, defaultCaseId + suffix)))) {
          defaultCaseId += `__${Date.now()}-${randomUUID().slice(0, 6)}`;
        }
        const caseIds = params.caseIds ?? (params.caseId ? [params.caseId] : mode === "record" && project ? [defaultCaseId] : []);
        if (!caseIds.length || new Set(caseIds).size !== caseIds.length ||
          caseIds.some((id) => !/^[\p{L}\p{N}_-]{1,180}$/u.test(id)) ||
          (params.caseIds && params.caseId) || (mode === "record" && caseIds.length !== 1)) {
          throw new Error("录制提供一个 caseId；回放提供 caseId 或不重复的 caseIds。");
        }
        const caseId = caseIds[0];
        if (project && mode === "run") {
          for (const id of caseIds) {
            let metadata;
            try { metadata = JSON.parse(await readFile(path.join(project.caseDir, `${id}.asset.json`), "utf8")); }
            catch { /* 缺失或损坏索引统一拒绝，不回显可能含敏感片段的 JSON 错误。 */ }
            if (metadata?.projectId !== project.projectId || metadata.targetUrl !== project.targetUrl || metadata.sha256 !== createHash("sha256").update(await readFile(path.join(project.caseDir, `${id}.spec.cjs`))).digest("hex")) {
              throw new Error("脚本尚未完成格式整理、语法检查或版本登记，请先调用 qa_ui_finalize。");
            }
          }
        }
        if (project && caseIds.some((id) => id !== project.assetName && !id.startsWith(project.assetName + "__"))) {
          throw new Error("项目脚本名称必须使用返回的项目名称与路径前缀。");
        }
        const loginId = params.loginId ?? project?.loginId;
        const login = loginId ? logins.get(loginId) : null;
        if (loginId && (!login || login.status !== "saved" || !existsSync(login.file) || login.origin !== parsedUrl.origin)) {
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

        const caseDir = project?.caseDir ?? path.join(workspace, "qa/ui/cases");
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
          project: project ? { id: project.projectId, name: project.projectName, address: project.address } : null,
          dataDir: project?.dataDir ?? null,
          assetFiles: project && mode === "run" ? caseIds.flatMap((id) => [
            path.join(caseDir, `${id}.md`), path.join(caseDir, `${id}.asset.json`),
          ]) : [],
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

        if (project) {
          if (mode === "record") project.recordings.set(caseId, prepared);
          await writeFile(path.join(runDir, "project-context.json"), JSON.stringify({
            projectId: project.projectId, projectName: project.projectName,
            address: project.address, targetUrl: project.targetUrl,
            workspace, dataDir: project.dataDir, caseIds,
            login: login ? "private-state" : "not-required",
          }, null, 2) + "\n", { flag: "wx" });
        }
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
