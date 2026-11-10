import { randomUUID } from "node:crypto";
import { userInfo } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

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

export function formatPromptDiagnostics(session, { agentDir, knownSecrets = [], now = new Date(), currentUser }) {
  const prompt = session.systemPrompt;
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
    `[Pi 桌面] 本轮完整系统提示词 round=${randomUUID()} session=${session.sessionId} ${prompt.length} 字符（原文长度；日志凭据脱敏）`,
    "---------- 系统提示词开始 ----------",
    prompt,
    "---------- 系统提示词结束 ----------",
    "---------- 动态配置开始 ----------",
    JSON.stringify(dynamic, null, 2),
    "---------- 动态配置结束 ----------",
  ].join("\n"), knownSecrets);
}

export function bindPromptDiagnostics(session, { agentDir, knownSecrets }) {
  // agent_start 在 before_agent_start 和扩展启动处理之后通知公共订阅者。
  // 每个实际运行记录一次；SDK dispose 会清除订阅，reload 不重新绑定。
  return session.subscribe(event => {
    if (event.type !== "agent_start") return;
    try {
      console.info(formatPromptDiagnostics(session, { agentDir, knownSecrets, currentUser: userInfo().username }));
    } catch {
      // 日志故障不改变运行结果，且不输出可能含敏感文本的原始异常。
      console.error("[Pi 桌面] 系统提示词日志记录失败；本轮诊断信息未确认。");
    }
  });
}
