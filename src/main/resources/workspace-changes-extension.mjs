// 每轮改动捕获：在 write/edit 真正执行前读取目标文件，供轮末生成差异。
// 只属于桌面展示；不改变 Pi 的工具语义，也不写入会话历史。
export function createWorkspaceChangesExtension(service) {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      if (!service || (event?.toolName !== "write" && event?.toolName !== "edit")) return;
      if (typeof event?.input?.path !== "string" || event.input.path.trim() === "") return;
      let sessionId = "";
      try {
        sessionId = ctx?.sessionManager?.getSessionId?.() ?? "";
      } catch {
        sessionId = "";
      }
      // 捕获失败不能阻止工具执行；权限门禁仍在前一步决定是否放行。
      await service.capture({
        sessionId,
        cwd: typeof ctx?.cwd === "string" ? ctx.cwd : "",
        toolName: event.toolName,
        input: event?.input,
      }).catch(() => {});
    });
  };
}
