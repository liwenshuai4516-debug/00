import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { resolveWorkspacePath } from "./path-policy.mjs";
import { createReadTextFileTool } from "../tools/read-text-file.mjs";

// 只处理文件保存。
// 后续由保存服务负责当前会话校验、互斥和草稿状态管理。
export async function applyWorkspaceEdit(workspaceDir, proposal) {
  const { oldText, newText } = proposal;

  if (
    proposal.kind !== "edit-proposal" ||
    proposal.written !== false ||
    typeof oldText !== "string" ||
    !oldText ||
    oldText.length > 1000 ||
    typeof newText !== "string" ||
    newText.length > 1000 ||
    oldText === newText
  ) {
    throw new Error("无法保存无效的修改草稿。");
  }

  const reader = createReadTextFileTool(workspaceDir);

  // 保存时重新检查，不能沿用页面审阅时的检查结果。
  async function readCurrent() {
    const resolved = await resolveWorkspacePath(
      workspaceDir,
      proposal.path,
    );

    const result = await reader.execute("apply-proposal", {
      path: proposal.path,
    });

    // 两次路径解析应指向同一个工作目录内的文件。
    if (result.details.path !== resolved.relativePath) {
      throw new Error("文件路径已发生变化，请重新生成草稿。");
    }

    const source = result.details.text;
    const hash = createHash("sha256")
      .update(source, "utf8")
      .digest("hex");

    if (hash !== proposal.baseTextHash) {
      throw new Error("文件已发生变化，请重新读取文件并生成草稿。");
    }

    return { ...resolved, source };
  }

  const current = await readCurrent();
  const index = current.source.indexOf(oldText);

  if (
    index === -1 ||
    current.source.indexOf(oldText, index + 1) !== -1
  ) {
    throw new Error("草稿不能唯一定位原文，请重新生成。");
  }

  const updated =
    current.source.slice(0, index) +
    newText +
    current.source.slice(index + oldText.length);

  if (Buffer.byteLength(updated, "utf8") > 32 * 1024) {
    throw new Error("修改后的文本超过 32 KiB，暂不支持。");
  }

  const info = await stat(current.target);

  // 临时文件放在目标文件所在目录，便于通过重命名替换。
  const temporaryPath = path.join(
    path.dirname(current.target),
    `.agent-edit-${randomUUID()}.tmp`,
  );

  let temporaryCreated = false;

  try {
    // wx 防止覆盖已有文件；临时写入期间仅当前用户可读写。
    const file = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;

    try {
      await file.writeFile(updated, "utf8");

      // 保留原文件的普通权限位，例如脚本的可执行权限。
      await file.chmod(info.mode & 0o777);
      await file.sync();
    } finally {
      await file.close();
    }

    // 临时文件准备完成后，再检查一次原文件。
    const latest = await readCurrent();

    if (latest.target !== current.target) {
      throw new Error("文件路径已发生变化，请重新生成草稿。");
    }

    // 不直接截断原文件；临时文件写完后才替换目标。
    await rename(temporaryPath, current.target);
    temporaryCreated = false;

    return {
      path: current.relativePath,
      written: true,
    };
  } finally {
    // 保存失败时清理本次创建的临时文件。
    if (temporaryCreated) {
      await rm(temporaryPath, { force: true });
    }
  }
}