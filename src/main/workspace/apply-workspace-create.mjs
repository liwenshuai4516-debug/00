import path from "node:path";
import { randomUUID } from "node:crypto";
import { open, link, rm } from "node:fs/promises";
import { resolveNewFilePath } from "./resolve-new-file-path.mjs";

// 只保存新建文件；会话归属、互斥和草稿状态由保存服务负责。
export async function applyWorkspaceCreate(workspaceDir, proposal) {
  const { content } = proposal;

  if (
    proposal.kind !== "create-proposal" ||
    proposal.written !== false ||
    typeof content !== "string" ||
    content.includes("\0") ||
    Buffer.byteLength(content, "utf8") > 32 * 1024
  ) {
    throw new Error("无法保存无效的新建草稿。");
  }

  // 保存时重新解析，不能直接采用审阅时的检查结果。
  const current = await resolveNewFilePath(workspaceDir, proposal.path);
  const temporaryPath = path.join(
    path.dirname(current.target),
    `.agent-create-${randomUUID()}.tmp`,
  );

  let temporaryCreated = false;
  let saveError;
  let cleanupError;

  try {
    const file = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;

    try {
      await file.writeFile(content, "utf8");
      await file.sync();
    } finally {
      await file.close();
    }

    const latest = await resolveNewFilePath(workspaceDir, proposal.path);

    if (latest.target !== current.target) {
      throw new Error("文件路径已发生变化，请重新生成草稿。");
    }

    // 为写完的文件增加目标名称；目标已存在时 link 会失败，不会覆盖。
    // 临时文件与目标位于同一目录，避免跨文件系统建立硬链接。
    await link(temporaryPath, current.target);
  } catch (error) {
    saveError = error;
  }

  // 无论发布是否成功，都清理自己创建的临时文件。
  if (temporaryCreated) {
    try {
      await rm(temporaryPath, { force: true });
    } catch (error) {
      cleanupError = error;
    }
  }

  if (saveError) {
    if (cleanupError) {
      throw new Error(
        `${saveError.message}；临时文件清理失败：${cleanupError.message}`,
      );
    }

    throw saveError;
  }

  // link 成功后目标已经存在，清理失败不能被报告为文件保存失败。
  return {
    path: current.relativePath,
    written: true,
    ...(cleanupError
      ? { warning: `文件已保存，但临时文件清理失败：${cleanupError.message}` }
      : {}),
  };
}