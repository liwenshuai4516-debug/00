const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, realpath, readFile, writeFile, rm } = require("node:fs/promises");

async function setup(t) {
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-resume-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  await mkdir(path.join(base, "workspace"));
  await mkdir(path.join(base, "other"));
  const workspace = await realpath(path.join(base, "workspace"));
  const other = await realpath(path.join(base, "other"));
  const sessionDir = path.join(base, "sessions");
  const { createWorkspaceSession } = await import("../../src/main/workspace/workspace-session.mjs");
  const { SessionManager } = await import("@mariozechner/pi-coding-agent");
  return { workspace, other, sessionDir, createWorkspaceSession, SessionManager };
}

function persist(manager, timestamp) {
  // 使用固定活动时间，确保“最新记录”的排序可重复；不请求模型。
  manager.appendMessage({
    role: "assistant", content: [{ type: "text", text: "测试回复" }],
    api: "openai-completions", provider: "test", model: "test",
    usage: {
      input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "stop", timestamp,
  });
}

test("自动恢复跳过较新的其他目录和无绑定会话", async (t) => {
  const { workspace, other, sessionDir, createWorkspaceSession, SessionManager } = await setup(t);
  const selected = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(selected.sessionManager, 1700000001000);
  const foreign = await createWorkspaceSession({ sessionDir, workspaceDir: other });
  persist(foreign.sessionManager, 1700000002000);
  const unbound = SessionManager.create(workspace, sessionDir);
  persist(unbound, 1700000003000);
  const foreignPath = foreign.sessionManager.getSessionFile();
  const oldPath = unbound.getSessionFile();
  const foreignBefore = await readFile(foreignPath, "utf8");
  const oldBefore = await readFile(oldPath, "utf8");

  const restored = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true });
  assert.equal(restored.sessionManager.getSessionId(), selected.sessionManager.getSessionId());
  assert.equal(await readFile(foreignPath, "utf8"), foreignBefore);
  assert.equal(await readFile(oldPath, "utf8"), oldBefore);
});

test("当前目录没有匹配历史时新建，并保留其他历史文件", async (t) => {
  const { workspace, other, sessionDir, createWorkspaceSession, SessionManager } = await setup(t);
  const foreign = await createWorkspaceSession({ sessionDir, workspaceDir: other });
  persist(foreign.sessionManager, 1700000001000);
  const unbound = SessionManager.create(workspace, sessionDir);
  persist(unbound, 1700000002000);
  const paths = [foreign.sessionManager.getSessionFile(), unbound.getSessionFile()];
  const before = await Promise.all(paths.map((file) => readFile(file, "utf8")));

  const created = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true });
  assert.equal(created.sessionManager.getCwd(), workspace);
  assert.notEqual(created.sessionManager.getSessionId(), foreign.sessionManager.getSessionId());
  assert.notEqual(created.sessionManager.getSessionId(), unbound.getSessionId());
  const binding = created.sessionManager.getEntries().find((entry) => entry.type === "custom");
  assert.equal(binding.data.workspaceRoot, workspace);
  assert.deepEqual(await Promise.all(paths.map((file) => readFile(file, "utf8"))), before);
});

test("显式打开旧格式无绑定会话时拒绝，拒绝前不迁移原文件", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession, SessionManager } = await setup(t);
  const old = SessionManager.create(workspace, sessionDir);
  persist(old, 1700000001000);
  const file = old.getSessionFile();
  const entries = (await readFile(file, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  entries[0].version = 1;
  for (const entry of entries.slice(1)) {
    delete entry.id;
    delete entry.parentId;
  }
  await writeFile(file, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  const before = await readFile(file, "utf8");

  // 显式指定路径优先，即使传入 resume 也不能静默改选其他会话。
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true, sessionPath: file }),
    /旧会话缺少工作目录绑定/,
  );
  assert.equal(await readFile(file, "utf8"), before);
});

test("重复绑定、未知绑定版本和头部目录不一致的候选不会被自动恢复", async (t) => {
  const { workspace, other, sessionDir, createWorkspaceSession, SessionManager } = await setup(t);
  const valid = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(valid.sessionManager, 1700000001000);
  for (const kind of ["duplicate", "version", "cwd"]) {
    const manager = SessionManager.create(kind === "cwd" ? other : workspace, sessionDir);
    manager.appendCustomEntry("desktop-workspace-binding", {
      version: kind === "version" ? 2 : 1, workspaceRoot: workspace,
    });
    if (kind === "duplicate") {
      manager.appendCustomEntry("desktop-workspace-binding", { version: 1, workspaceRoot: workspace });
    }
    persist(manager, 1700000002000);
    const file = manager.getSessionFile();
    const before = await readFile(file, "utf8");
    const restored = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true });
    assert.equal(restored.sessionManager.getSessionId(), valid.sessionManager.getSessionId());
    assert.equal(await readFile(file, "utf8"), before);
    await assert.rejects(
      createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath: file }),
      /绑定记录无效|目录与绑定记录不一致/,
    );
  }
});

test("同一目录有多份合法会话时恢复最近活动的记录", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession } = await setup(t);
  const first = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(first.sessionManager, 1700000001000);
  const latest = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(latest.sessionManager, 1700000003000);
  const middle = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(middle.sessionManager, 1700000002000);

  const restored = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true });
  assert.equal(restored.sessionManager.getSessionId(), latest.sessionManager.getSessionId());
});
