const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, realpath, symlink, readFile, writeFile, rm,
} = require("node:fs/promises");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-workspace-session-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const workspace = path.join(base, "workspace");
  const other = path.join(base, "other");
  const sessionDir = path.join(base, "sessions");
  await mkdir(workspace);
  await mkdir(other);
  const { createWorkspaceSession } = await import(
    "../../src/main/workspace/workspace-session.mjs"
  );
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  return { base, workspace, other, sessionDir, createWorkspaceSession, SessionManager };
}

function flushSession(manager) {
  // Pi 在出现助手消息后才写出会话；这里仅写测试消息，不请求模型。
  manager.appendMessage({
    role: "assistant",
    content: [{ type: "text", text: "测试回复" }],
    api: "openai-completions", provider: "test", model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop", timestamp: Date.now(),
  });
}

test("新会话绑定真实目录，绑定元数据不进入模型上下文", async (t) => {
  const { base, workspace, sessionDir, createWorkspaceSession } = await setup(t);
  const alias = path.join(base, "workspace-alias");
  await symlink(workspace, alias);
  const result = await createWorkspaceSession({ sessionDir, workspaceDir: alias });
  const root = await realpath(workspace);
  assert.equal(result.workspaceRoot, root);
  assert.equal(result.sessionManager.getCwd(), root);
  assert.equal(result.sessionManager.getEntries()[0].customType, "desktop-workspace-binding");
  assert.deepEqual(result.sessionManager.buildSessionContext().messages, []);
});

test("同一目录和符号链接别名均能恢复原会话", async (t) => {
  const { base, workspace, sessionDir, createWorkspaceSession } = await setup(t);
  const original = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  flushSession(original.sessionManager);
  const sessionPath = original.sessionManager.getSessionFile();
  const alias = path.join(base, "alias");
  await symlink(workspace, alias);
  const reopened = await createWorkspaceSession({ sessionDir, workspaceDir: alias, sessionPath });
  assert.equal(reopened.sessionManager.getSessionId(), original.sessionManager.getSessionId());
  assert.equal(reopened.sessionManager.getEntries().filter(e => e.type === "custom").length, 1);
});

test("更换工作目录后拒绝打开旧会话，不改写原文件", async (t) => {
  const { workspace, other, sessionDir, createWorkspaceSession } = await setup(t);
  const original = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  flushSession(original.sessionManager);
  const sessionPath = original.sessionManager.getSessionFile();
  const before = await readFile(sessionPath, "utf8");
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: other, sessionPath }),
    /属于其他工作目录/,
  );
  assert.equal(await readFile(sessionPath, "utf8"), before);
});

test("无绑定的历史会话拒绝自动认领，原记录保持完整", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession, SessionManager } = await setup(t);
  const old = SessionManager.create(workspace, sessionDir);
  flushSession(old);
  const sessionPath = old.getSessionFile();
  const before = await readFile(sessionPath, "utf8");
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath }),
    /旧会话缺少工作目录绑定/,
  );
  assert.equal(await readFile(sessionPath, "utf8"), before);
});

test("自动恢复只使用当前目录，无匹配历史时创建新会话", async (t) => {
  const {
    workspace,
    other,
    sessionDir,
    createWorkspaceSession,
  } = await setup(t);

  const original = await createWorkspaceSession({
    sessionDir,
    workspaceDir: workspace,
    resume: true,
  });

  flushSession(original.sessionManager);

  // 同一目录再次启动，恢复已经保存的会话。
  const restored = await createWorkspaceSession({
    sessionDir,
    workspaceDir: workspace,
    resume: true,
  });

  assert.equal(
    restored.sessionManager.getSessionId(),
    original.sessionManager.getSessionId(),
  );

  // 更换目录后没有匹配记录，应创建属于新目录的会话。
  const created = await createWorkspaceSession({
    sessionDir,
    workspaceDir: other,
    resume: true,
  });

  assert.notEqual(
    created.sessionManager.getSessionId(),
    original.sessionManager.getSessionId(),
  );

  assert.equal(
    created.sessionManager.getCwd(),
    await realpath(other),
  );
});

test("拒绝无效目录配置和不存在的指定会话文件", async (t) => {
  const { base, workspace, sessionDir, createWorkspaceSession } = await setup(t);
  for (const workspaceDir of [undefined, "relative/path"]) {
    await assert.rejects(createWorkspaceSession({ sessionDir, workspaceDir }), /配置为绝对路径/);
  }
  const filename = path.join(base, "file.txt");
  await writeFile(filename, "test");
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: filename }),
    /必须指向目录/,
  );
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath: path.join(base, "missing.jsonl") }),
    { code: "ENOENT" },
  );
});
