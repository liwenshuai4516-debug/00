import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// 启动诊断只处理日志副本，不修改发送给 Pi 的提示词或读取认证配置。
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
// 日志只保留可用数量，避免把整个目录正文写进控制台；模型输入不受影响。
export function stripSkillsCatalog(prompt) {
  const section = prompt.match(/(^|\n)<skills>\n[\s\S]*?\n<\/skills>(?=\n|$)/);
  if (!section) return { prompt, omitted: 0 };
  const skillCount = (section[0].match(/<skill>/g) ?? []).length;
  const placeholder = `<skills>\n（技能目录正文已省略：可用技能 ${skillCount} 个）\n</skills>`;
  return { prompt: prompt.replace(section[0], `${section[1] ?? ""}${placeholder}`), omitted: section[0].length };
}

export function formatPromptDiagnostics(session, { agentDir, agentSystemPrompt, testAgentPrompt, knownSecrets = [], now = new Date(), currentUser, role = "main" }) {
  const prompt = session.systemPrompt;
  const { prompt: visiblePrompt } = stripSkillsCatalog(prompt);
  let promptLog = visiblePrompt;
  const prefix = [testAgentPrompt, agentSystemPrompt].join("\n\n");
  // 只拆分已确认的会话主体；扩展若整体替换提示词，继续打印实际原文。
  if (typeof agentSystemPrompt === "string" && typeof testAgentPrompt === "string" && prompt.startsWith(prefix)) {
    const sections = [
      ["AGENT_SYSTEM_PROMPT", agentSystemPrompt],
      ["TEST_AGENT_PROMPT（当前会话测试职责）", testAgentPrompt],
      ["其余系统提示词", prompt.slice(prefix.length).trimStart()],
    ];
    promptLog = sections.filter(([, text]) => text !== "").map(([name, text]) => [
      `---------- ${name} 开始 ----------`,
      stripSkillsCatalog(text).prompt,
      `---------- ${name} 结束 ----------`,
    ].join("\n")).join("\n\n");
  }
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
    promptLog,
    "---------- 系统提示词结束 ----------",
    "---------- 动态配置开始 ----------",
    JSON.stringify(dynamic, null, 2),
    "---------- 动态配置结束 ----------",
  ].join("\n"), knownSecrets);
}

// 会话创建完成（扩展已绑定、技能与工具已登记）时打印一次初始系统提示词。
export function logInitialPrompt(session, options) {
  try {
    // 未显式传入时使用操作系统用户名；不冒充业务系统账号。
    console.info(formatPromptDiagnostics(session, { currentUser: userInfo().username, ...options }));
  } catch {
    // 日志故障不改变运行结果，且不输出可能含敏感文本的原始异常。
    console.error("[Pi 桌面] 初始系统提示词日志记录失败；诊断信息未确认。");
  }
}
