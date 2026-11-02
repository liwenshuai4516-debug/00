# 下一步：由实际创建流程标记会话来源

状态：手写候选，尚未接入实际应用。使用者已完成上一小步的恢复登记存储，实际语法检查和 4 个相关文件 30 项测试全部通过；本指南是下一小步。

## 本步目标与取舍

在接入输入保存前，先给主进程可信的来源依据。工作目录模块已经有明确的两个分支：通过绑定检查后打开真实历史，或创建全新的空会话。本步骤只在这两个分支返回来源，并把来源留在真实 Pi 会话对象上。

成功标准：显式打开和自动恢复的真实历史均标记 history；明确新建或自动恢复无匹配历史时标记 empty；明确指定但丢失的历史仍然报错，不改成空会话；不创建虚构聊天消息，不改变模型选择与目录恢复规则。

这里只记录“创建时来源”。空会话后来产生真实消息时，下一小步服务接线还必须推进持久化来源，不能把初始 empty 当作永久的空会话证明。

本步仅修改两个应用文件，新增一个测试文件。你亲手修改；助手只编写了本指南，并在临时副本验证候选。

## 1. 在工作目录会话模块返回可信来源

文件：`src/main/workspace/workspace-session.mjs`。

找到 `if (selectedPath) {` 分支中完整的 return：

```javascript
    return {
      workspaceRoot,
      sessionManager: SessionManager.open(
        selectedPath,
        sessionDir,
      ),
    };
```

只将这个 return 替换为：

```javascript
    return {
      workspaceRoot,
      // 来源由通过绑定检查后的实际分支确定，不靠文件缺失推断。
      source: "history",
      sessionManager: SessionManager.open(
        selectedPath,
        sessionDir,
      ),
    };
```

再找到函数末尾、绑定添加之后的 return：

```javascript
  return {
    workspaceRoot,
    sessionManager: manager,
  };
```

只将这个 return 替换为：

```javascript
  return {
    workspaceRoot,
    source: "empty",
    sessionManager: manager,
  };
```

保持路径校验、绑定检查、自动恢复筛选和 SessionManager.create 调用不变。来源不是通过 `!existsSync(sessionFile)` 判断出来的。

## 2. 将来源留在主进程的 Pi 会话对象上

文件：`src/main/pi-agent.mjs`。

找到：

```javascript
  const { workspaceRoot, sessionManager } = await createWorkspaceSession({
```

只将这一行替换为：

```javascript
  const { workspaceRoot, sessionManager, source } = await createWorkspaceSession({
```

再找到函数末尾：

```javascript
  // 仅主进程持有配置服务；不把密钥或服务对象返回页面。
  if (managed) session.desktopModelSettings = modelSettings;
  return session;
```

将这三行整体替换为：

```javascript
  // 仅记录创建时的可信来源；后续产生消息时仍需推进持久化登记。
  session.desktopSessionOrigin = source;

  // 仅主进程持有配置服务；不把密钥或服务对象返回页面。
  if (managed) session.desktopModelSettings = modelSettings;
  return session;
```

保留 modelSettings 第五参数、resolveSelection、配置安装和 createAgentSession 逻辑。新增字段只由主进程后续业务使用，不扩展 IPC、preload 或页面 DTO。

## 3. 新建专项测试

新建 `tests/unit/session-origin.test.js`，完整内容如下：

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { promisify } = require("node:util");
const { execFile } = require("node:child_process");
const { pathToFileURL } = require("node:url");
const runFile = promisify(execFile);

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-origin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  const other = path.join(root, "other");
  await fs.mkdir(workspace);
  await fs.mkdir(other);
  const { createWorkspaceSession } = await import(
    "../../src/main/workspace/workspace-session.mjs"
  );
  return {
    root, workspace, other, createWorkspaceSession,
    sessionDir: path.join(root, "sessions"),
  };
}

function persist(manager) {
  // Pi 1.4 从真实用户消息开始写历史；测试只追加本地数据，不请求模型。
  manager.appendMessage({ role: "user", content: "来源测试", timestamp: Date.now() });
}

test("新建与无匹配历史的自动恢复均标记 empty，不制造聊天记录", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession } = await setup(t);
  for (const resume of [false, true]) {
    const result = await createWorkspaceSession({
      sessionDir, workspaceDir: workspace, resume,
    });
    assert.equal(result.source, "empty");
    assert.deepEqual(result.sessionManager.buildSessionContext().messages, []);
    await assert.rejects(fs.stat(result.sessionManager.getSessionFile()), { code: "ENOENT" });
  }
});

test("显式打开历史标记 history，原文件后来丢失也不降级", async (t) => {
  const { workspace, sessionDir, createWorkspaceSession } = await setup(t);
  const original = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(original.sessionManager);
  const sessionPath = original.sessionManager.getSessionFile();
  const opened = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath });
  assert.equal(opened.source, "history");
  assert.equal(opened.sessionManager.getSessionId(), original.sessionManager.getSessionId());
  await fs.rm(sessionPath);
  assert.equal(opened.source, "history");
  // 明确指定丢失历史仍必须报错，不能改为创建空会话。
  await assert.rejects(
    createWorkspaceSession({ sessionDir, workspaceDir: workspace, sessionPath }),
    { code: "ENOENT" },
  );
});

test("自动恢复的合法历史为 history，其他目录无历史仍为 empty", async (t) => {
  const { workspace, other, sessionDir, createWorkspaceSession } = await setup(t);
  const original = await createWorkspaceSession({ sessionDir, workspaceDir: workspace });
  persist(original.sessionManager);
  const restored = await createWorkspaceSession({ sessionDir, workspaceDir: workspace, resume: true });
  assert.equal(restored.source, "history");
  assert.equal(restored.sessionManager.getSessionId(), original.sessionManager.getSessionId());
  const created = await createWorkspaceSession({ sessionDir, workspaceDir: other, resume: true });
  assert.equal(created.source, "empty");
  assert.notEqual(created.sessionManager.getSessionId(), original.sessionManager.getSessionId());
});

test("真实 Pi 会话保留来源与实际模型，初始化和恢复都不请求模型", async (t) => {
  const { root, workspace, sessionDir } = await setup(t);
  const agentUrl = pathToFileURL(require.resolve("../../src/main/pi-agent.mjs")).href;
  const script = `
    const assert = require("node:assert/strict");
    const { existsSync } = require("node:fs");
    globalThis.fetch = async () => assert.fail("测试不能访问网络或模型");
    async function check() {
      const { createPiAgent } = await import(${JSON.stringify(agentUrl)});
      const [sessionDir, workspace] = process.argv.slice(1);
      const first = await createPiAgent(sessionDir, false, undefined, workspace);
      let id;
      let file;
      try {
        assert.equal(first.desktopSessionOrigin, "empty");
        assert.equal(existsSync(first.sessionFile), false);
        assert.deepEqual(first.messages, []);
        // 切换只有模型元数据，不应制造聊天历史或改变初始来源。
        const pro = first.modelRuntime.getModel("deepseek", "deepseek-v4-pro");
        assert.ok(pro);
        await first.setModel(pro, { persist: false });
        assert.equal(first.model.id, "deepseek-v4-pro");
        assert.equal(first.desktopSessionOrigin, "empty");
        assert.equal(existsSync(first.sessionFile), false);
        id = first.sessionId;
        file = first.sessionFile;
        first.sessionManager.appendMessage({
          role: "user", content: "临时来源测试", timestamp: Date.now(),
        });
        assert.equal(existsSync(file), true);
      } finally {
        first.dispose();
      }
      const opened = await createPiAgent(sessionDir, false, file, workspace);
      try {
        assert.equal(opened.desktopSessionOrigin, "history");
        assert.equal(opened.sessionId, id);
        assert.equal(opened.model.id, "deepseek-v4-pro");
      } finally {
        opened.dispose();
      }
      const resumed = await createPiAgent(sessionDir, true, undefined, workspace);
      try {
        assert.equal(resumed.desktopSessionOrigin, "history");
        assert.equal(resumed.sessionId, id);
      } finally {
        resumed.dispose();
      }
    }
    check().catch(error => { console.error(error); process.exitCode = 1; });
  `;
  const result = await runFile(process.execPath, ["-e", script, sessionDir, workspace], {
    env: {
      ...process.env,
      PI_CODING_AGENT_DIR: path.join(root, "pi-config"),
      PI_OFFLINE: "1",
      PI_PROVIDER: "deepseek",
      PI_MODEL: "deepseek-flash",
      PI_BASE_URL: "https://example.invalid/v1",
      DEEPSEEK_API_KEY: "test-only-placeholder",
      AGENT_WORKSPACE_DIR: workspace,
    },
    encoding: "utf8",
  });
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "");
});
```

测试中的 deepseek-v4-pro 是本项目实际 SDK 已登记的模型 ID；测试不会调用 prompt。用户消息仅写入临时测试历史，不能把这种测试准备方式搬到应用逻辑中。

## 4. 执行针对性验证

在项目根目录运行：

```bash
node --check src/main/workspace/workspace-session.mjs
node --check src/main/pi-agent.mjs
node --test \
  tests/unit/session-origin.test.js \
  tests/unit/workspace-session.test.js \
  tests/unit/workspace-resume.test.js \
  tests/unit/pi-agent-init.test.js \
  tests/unit/pi-workspace.test.js \
  tests/unit/model-restore.test.js \
  tests/unit/model-profiles.test.js
```

候选已在实际源码临时副本中通过两个脚本的语法检查，以及上述 7 个测试文件共 20 项测试，其中来源专项新增 4 项。验证涵盖新建不落盘、显式和自动恢复、其他目录无匹配历史、历史丢失拒绝回退、真实 Pi 初始化、模型切换及恢复和多配置回归。使用临时配置/会话、占位凭据并禁止网络，不读取真实配置或会话，不请求模型。

这些是候选验证结果。你亲手修改实际文件后，仍需执行以上检查；页面本步没有新入口，无需为这一小步发起真实模型请求。

## 本步完成后的下一步

再把登记接入输入服务：读取时固定实际会话归属，保存时把原编号、真实目录、可信来源和 `{ provider: session.model.provider, modelId: session.model.id }` 一起登记，保证切换后迟到保存仍属于原会话。新配置的运行时 provider 包含配置编号，不用页面展示的 provider 替代。

接线时需要同时处理：新会话产生真实消息后来源只向 history 推进、模型切换成功或部分失败后的实际选择同步、磁盘写入失败可重试。不要在本小步自行调用 registerSession；直接加在页面或用文件缺失判定来源会破坏既定边界。

SDK 的 isPersisted() 表示开启持久化，并不证明历史文件已经写出，不能拿它替代来源判断。旧状态没有登记也不构成空会话证明。

侧栏找回入口、按原编号重建、关闭前补保存仍未完成，继续按 AGENTS.md 顺序推进。
