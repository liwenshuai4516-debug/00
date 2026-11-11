import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSkillBlock } from "@mariozechner/pi-coding-agent";

// 运行期诊断只处理日志副本，不修改发送给 Pi 的提示词或读取认证配置。
export function redactPromptLog(value, knownSecrets = []) {
  let result = value;
  for (const secret of knownSecrets) {
    if (typeof secret === "string" && secret.length > 0) result = result.replaceAll(secret, "[已脱敏]");
  }
  return result
    .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/g, "[私钥已脱敏]")
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, "$1 [已脱敏]")
    .replace(/((?:set-cookie|cookie|authorization)\s*:\s*)[^\r\n]+/gi, "$1[已脱敏]")
    .replace(/((?:["']?)(?:api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|authorization|cookie|set-cookie|密码|令牌)(?:["']?)\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s,;\r\n}]+)/gi, "$1[已脱敏]")
    .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[已脱敏]@")
    .replace(/([?&](?:key|token|secret|password|api[_-]?key|access[_-]?token)=)[^\s&#"']+/gi, "$1[已脱敏]");
}

// 技能目录是 Pi 生成的“可用技能”清单，不是运行时已加载的技能。
// 日志只保留可用数量与加载入口说明，避免把整个目录正文写进控制台；模型输入不受影响。
export function stripSkillsCatalog(prompt) {
  const section = prompt.match(/(^|\n)<skills>\n[\s\S]*?\n<\/skills>(?=\n|$)/);
  if (!section) return { prompt, omitted: 0 };
  const skillCount = (section[0].match(/<skill>/g) ?? []).length;
  const placeholder = `<skills>\n（技能目录正文已省略：可用技能 ${skillCount} 个。运行时实际加载的技能见 [Pi 桌面] 已加载技能 日志）\n</skills>`;
  return { prompt: prompt.replace(section[0], `${section[1] ?? ""}${placeholder}`), omitted: section[0].length };
}

export function formatPromptDiagnostics(session, { agentDir, knownSecrets = [], now = new Date(), currentUser, role = "main" }) {
  const prompt = session.systemPrompt;
  const { prompt: visiblePrompt } = stripSkillsCatalog(prompt);
  const cwd = session.sessionManager.getCwd();
  const tools = session.getAllTools().filter(tool => tool.name.startsWith("mcp__") ||
    ["list_mcp_resources", "list_mcp_resource_templates", "read_mcp_resource"].includes(tool.name));
  const mcpEnabled = session.extensionRunner.hasHandlers("mcp_servers_change");
  const time = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).format(now);
  const dynamic = {
    北京时间: `${time} Asia/Shanghai (UTC+08:00)`,
    当前用户: { 类型: "操作系统用户（非业务系统账号）", 名称: currentUser },
    工作区名: path.basename(cwd),
    连接器: {
      MCP接入: mcpEnabled ? "已启用" : "未加载",
      已登记MCP工具: tools.map(tool => ({ name: tool.name, exposure: tool.exposure })),
      连接与登录状态: "未查询，工具登记不代表连接或认证成功",
    },
    真实运行路径: {
      会话工作目录: cwd,
      进程工作目录: process.cwd(),
      可执行文件: process.execPath,
      Agent入口: fileURLToPath(new URL("../pi-agent.mjs", import.meta.url)),
      Pi资源目录: agentDir,
      会话存储目录: session.sessionManager.getSessionDir(),
    },
  };
  return redactPromptLog([
    `[Pi 桌面] 初始系统提示词（技能目录已省略） session=${session.sessionId} role=${role} ${prompt.length} 字符（原文长度；日志凭据脱敏）`,
    "---------- 系统提示词开始 ----------",
    visiblePrompt,
    "---------- 系统提示词结束 ----------",
    "---------- 动态配置开始 ----------",
    JSON.stringify(dynamic, null, 2),
    "---------- 动态配置结束 ----------",
  ].join("\n"), knownSecrets);
}

// 会话创建完成（扩展已绑定、技能与工具已登记）时打印一次初始系统提示词；
// 每轮运行只打印工具调用与动态加载的技能，不重复打印整段提示词。
export function logInitialPrompt(session, options) {
  try {
    // 未显式传入时使用操作系统用户名；不冒充业务系统账号。
    console.info(formatPromptDiagnostics(session, { currentUser: userInfo().username, ...options }));
  } catch {
    // 日志故障不改变运行结果，且不输出可能含敏感文本的原始异常。
    console.error("[Pi 桌面] 初始系统提示词日志记录失败；诊断信息未确认。");
  }
}

// 技能是否“已加载”只认 Pi 原生信号：read 工具读到技能文件，或 /skill:name 展开后的
// user 消息与 loader 登记一致。bash 等间接读取不猜测，避免误报。
export function bindPromptDiagnostics(session, { knownSecrets }) {
  let roundId = randomUUID();
  const loadedThisRound = new Set();
  const toolStarted = new Map();
  const skills = () => session.resourceLoader?.getSkills?.().skills ?? [];
  const cwd = () => session.sessionManager?.getCwd?.() ?? process.cwd();
  // 日志故障不改变运行结果，且不输出可能含敏感文本的原始异常。
  function logLine(text) {
    try {
      console.info(text);
    } catch {
      // 控制台不可写时保持运行结果不变。
    }
  }
  function reportLoaded(skill, source) {
    const key = `${source}:${skill.name}`;
    if (loadedThisRound.has(key)) return;
    loadedThisRound.add(key);
    logLine(redactPromptLog(
      `[Pi 桌面] 已加载技能 round=${roundId} session=${session.sessionId} name="${skill.name}" source=${source} path=${skill.filePath}`,
      knownSecrets,
    ));
  }
  return session.subscribe(event => {
    if (event.type === "tool_execution_start") {
      toolStarted.set(event.toolCallId, performance.now());
      // 只记录工具名与调用耗时，不打印参数、命令正文、结果或其他正文。
      logLine(`[Pi 桌面] 工具调用 round=${roundId} session=${session.sessionId} tool=${event.toolName} call=${event.toolCallId}`);
      if (event.toolName === "read" && typeof event.args?.path === "string") {
        const target = path.resolve(cwd(), event.args.path);
        const skill = skills().find(item => item.filePath && path.resolve(cwd(), item.filePath) === target);
        if (skill) reportLoaded(skill, "read");
      }
      return;
    }
    if (event.type === "tool_execution_end") {
      const started = toolStarted.get(event.toolCallId);
      toolStarted.delete(event.toolCallId);
      const elapsed = event.durationMs !== undefined ? ` ${Math.round(event.durationMs)} ms`
        : started === undefined ? "" : ` ${Math.round(performance.now() - started)} ms（日志观察计时）`;
      logLine(`[Pi 桌面] 工具返回 round=${roundId} session=${session.sessionId} tool=${event.toolName} status=${event.isError ? "error" : "ok"}${elapsed} call=${event.toolCallId}`);
      return;
    }
    if (event.type === "message_end" && event.message?.role === "user") {
      const text = typeof event.message.content === "string" ? event.message.content
        : (event.message.content ?? []).filter(item => item.type === "text").map(item => item.text).join("");
      if (!text.startsWith("<skill")) return;
      const expanded = parseSkillBlock(text);
      if (!expanded) return;
      const skill = skills().find(item => item.name === expanded.name &&
        item.filePath && path.resolve(cwd(), item.filePath) === path.resolve(cwd(), expanded.location));
      if (skill) reportLoaded(skill, "explicit");
      return;
    }
    if (event.type !== "agent_start") return;
    // agent_start 在 before_agent_start 和扩展启动处理之后通知公共订阅者。
    // 运行期不再重复打印整段提示词，只按轮次归组工具调用与技能加载日志。
    roundId = randomUUID();
    loadedThisRound.clear();
    toolStarted.clear();
    // 每次实际运行留一条轻量轮次标记，供工具调用与技能加载日志关联。
    logLine(`[Pi 桌面] 本轮运行 round=${roundId} session=${session.sessionId}`);
  });
}
