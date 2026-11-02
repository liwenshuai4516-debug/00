# 下一小步：会话置顶服务与列表元数据

状态：2026-11-02已核对实际源码并在临时副本验证候选；实际应用与测试尚未修改。继续由使用者亲手编写。上一轮正常关闭与重启必做验收已收到“做完了”的整体反馈，不重复实施；生成、整理、系统窗口及中文组词中关闭未获得单独反馈，不扩大验收结论。

## 本步范围与成功标准

先完成置顶的主进程服务，为后续侧栏接线提供基础。复用已有`sessionStateStore.update()`队列，只写`pinnedAt`，不另建存储文件格式。

- `setSessionPinned(sessionId, true/false)`只接受已有历史会话和布尔值；重复置顶保留首次时间，取消置顶写`null`。
- 列表增加`pinnedAt`，默认`null`；历史列表仍保留消息活动顺序。页面接线时才在原工作目录组内按置顶时间排序，置顶不影响项目自动恢复目标。
- 不创建/切换Agent，不请求模型，不修改Pi历史、输入版本、发送快照、模型登记和归档字段。已有历史目录即使暂时不存在，也可保存组织状态，不尝试认领为当前目录。
- 缺少历史、缺少目录、重复编号、目录归属冲突或状态损坏均明确报错；失败不重置输入或历史，可重试。

本步尚无页面入口；完成后再接互斥IPC、受限预加载接口和侧栏置顶操作。归档单独实施，必须同时覆盖启动与项目恢复过滤、当前会话归档的准备/落盘/切换及可撤销恢复，不能只隐藏列表。

计划：

1. 补列表元数据和置顶方法 → 验证：10项新增专项。
2. 调整原列表字段预期 → 验证：旧列表3项仍通过。
3. 检查输入与存储等相关链路 → 验证：三个脚本语法检查、下列7文件共49项通过。

## 1. 修改会话服务

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/main/services/session-service.js`。

找到`async function listSessions()`，将该函数整体替换为以下两个函数。上方`readSessions()`及下方`readRecoveryWorkspace()`保留，不改参数、工厂、模型、目录切换等其他逻辑。无需新导入。

```javascript
  async function listSessions() {
    const sessions = await readSessions();

    return Promise.all(sessions.map(async (session) => {
      const state = sessionStateStore
        ? await sessionStateStore.load(session.id)
        : null;
      if (state && state.workspaceDir !== session.cwd) {
        throw new Error("会话工作目录不匹配。");
      }

      return {
        id: session.id,
        title: session.name || session.firstMessage || "未命名对话",
        // 目录只用于列表归组；打开会话仍须通过原有绑定检查。
        workspaceDir: session.cwd,
        // 消息活动时间保持不变，置顶排序留给页面在原目录组内处理。
        updatedAt: session.modified.getTime(),
        pinnedAt: state?.pinnedAt ?? null,
      };
    }));
  }

  // 后续由IPC互斥入口调用；页面只给历史编号和明确的布尔状态。
  async function setSessionPinned(sessionId, pinned) {
    if (!sessionStateStore) throw new Error("尚未配置会话状态存储。");
    if (typeof sessionId !== "string" || !sessionId.trim()) {
      throw new Error("请选择历史对话。");
    }
    if (typeof pinned !== "boolean") {
      throw new Error("置顶状态无效。");
    }

    const matches = (await readSessions()).filter(session => session.id === sessionId);
    if (!matches.length) {
      throw new Error("未找到该历史对话，请刷新列表后重试。");
    }
    if (matches.length !== 1) {
      throw new Error("发现多份相同编号的历史，无法确定置顶目标。");
    }
    const selected = matches[0];
    if (!selected.cwd) {
      throw new Error("该历史对话缺少工作目录，暂不能置顶。");
    }

    // 在共享写队列内合并最新状态；不改输入版本、发送快照或恢复登记。
    const state = await sessionStateStore.update(sessionId, selected.cwd, current => ({
      ...current,
      // 重复置顶保留原时间，避免重试改变排序。
      pinnedAt: pinned ? (current.pinnedAt ?? Date.now()) : null,
    }));
    return { id: sessionId, pinnedAt: state.pinnedAt };
  }
```

再在同文件末尾的`return { ... }`中，找到`listSessions,`，在其后添加一行；周围其他导出全部保留：

```javascript
    listSessions,
    setSessionPinned,
    listUnsentSessions,
```

应用入口已经注入共享状态存储，本步不修改`bootstrap.js`。旧测试或旧调用未注入存储时，列表仍可读取并返回`pinnedAt: null`，但置顶方法明确拒绝，不假装保存成功。

## 2. 调整原列表测试的字段预期

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/session-list.test.js`。

保留全部原测试，仅将两个`assert.deepEqual(await service.listSessions(), [...])`中的三个对象分别改为：

第一项测试中的两个对象：

```javascript
    { id: "second", title: "问题-second", workspaceDir: secondDir, updatedAt: secondTime, pinnedAt: null },
    { id: "first", title: "重命名对话", workspaceDir: firstDir, updatedAt: firstTime, pinnedAt: null },
```

第二项测试中的一个对象：

```javascript
    { id: "old", title: "问题-old", workspaceDir: "", updatedAt, pinnedAt: null },
```

第三项空列表测试保持原样。不要删除精确字段比较或历史字节不变的断言。

## 3. 新增置顶专项测试

新建`/Users/liyingjun/Desktop/SW-QA/17-00/tests/unit/session-pin.test.js`，完整内容如下。所有历史与状态均位于测试临时目录，模拟函数禁止创建Agent和读取当前工作目录配置。

```javascript
const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const fs = require("node:fs/promises");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createSessionStateStore } = require("../../src/main/storage/session-state-store.js");

async function setup(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "agent-session-pin-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const sessions = path.join(root, "sessions");
  const directory = path.join(root, "state");
  const workspace = path.join(root, "workspace");
  await fs.mkdir(sessions);
  const store = createSessionStateStore(directory);
  const makeService = (stateStore = store) => createSessionService(
    sessions,
    () => assert.fail("置顶和列表不能创建 Agent"),
    () => assert.fail("置顶和列表不能读取当前目录配置"),
    undefined,
    stateStore,
  );
  return { root, sessions, directory, workspace, store, makeService, service: makeService() };
}

async function writeHistory(s, id, cwd = s.workspace, updatedAt = 1000, filename = id) {
  const timestamp = new Date(updatedAt).toISOString();
  const entries = [
    { type: "session", version: 3, id, cwd, timestamp },
    {
      type: "message", id: "u1", parentId: null, timestamp,
      message: { role: "user", content: `问题-${id}`, timestamp: updatedAt },
    },
  ];
  const file = path.join(s.sessions, `${filename}.jsonl`);
  const content = entries.map(entry => JSON.stringify(entry)).join("\n") + "\n";
  await fs.writeFile(file, content);
  return { file, content };
}

function withoutPin(state) {
  const { pinnedAt, ...rest } = state;
  return rest;
}

test("列表默认未置顶，不创建状态或Agent，不改写历史", async (t) => {
  const s = await setup(t);
  const history = await writeHistory(s, "a");
  assert.deepEqual(await s.service.listSessions(), [
    { id: "a", title: "问题-a", workspaceDir: s.workspace, updatedAt: 1000, pinnedAt: null },
  ]);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
  assert.equal(await fs.readFile(history.file, "utf8"), history.content);
});

test("置顶持久化，重复置顶保留时间，取消后列表恢复null", async (t) => {
  const s = await setup(t);
  const history = await writeHistory(s, "a");
  const before = Date.now();
  const pinned = await s.service.setSessionPinned("a", true);
  assert.equal(pinned.id, "a");
  assert.ok(pinned.pinnedAt >= before && pinned.pinnedAt <= Date.now());
  assert.deepEqual(await s.service.setSessionPinned("a", true), pinned);
  const reopened = s.makeService(createSessionStateStore(s.directory));
  assert.equal((await reopened.listSessions())[0].pinnedAt, pinned.pinnedAt);
  assert.deepEqual(await reopened.setSessionPinned("a", false), { id: "a", pinnedAt: null });
  assert.equal((await s.service.listSessions())[0].pinnedAt, null);
  assert.equal(await fs.readFile(history.file, "utf8"), history.content);
});

test("置顶与取消保留输入版本、发送快照、来源模型和归档字段", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.registerSession("a", s.workspace, "history", { provider: "test", modelId: "model" });
  await s.store.saveDraft("a", s.workspace, "发送原文", 0);
  await s.store.consumeDraft("a", s.workspace, "发送原文", 1);
  await s.store.saveDraft("a", s.workspace, " 后来输入\r\n ", 2);
  const original = await s.store.update("a", s.workspace, state => ({ ...state, archivedAt: 20 }));
  for (const value of [true, false]) {
    await s.service.setSessionPinned("a", value);
    assert.deepEqual(withoutPin(await s.store.load("a")), withoutPin(original));
  }
});

test("与输入保存并行时合并最新状态，不覆盖迟到输入", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.saveDraft("a", s.workspace, "旧输入", 0);
  await Promise.all([
    s.service.setSessionPinned("a", true),
    s.store.saveDraft("a", s.workspace, " 新输入\r\n", 1),
  ]);
  const state = await s.store.load("a");
  assert.deepEqual(state.draft, { text: " 新输入\r\n", revision: 2 });
  assert.equal(typeof state.pinnedAt, "number");
});

test("列表仍按消息活动返回，置顶不更新活动时间或泄露输入", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "older", path.join(s.root, "team-a", "demo"), 1000);
  await writeHistory(s, "newer", path.join(s.root, "team-b", "demo"), 2000);
  await s.service.setSessionPinned("older", true);
  const rows = await s.service.listSessions();
  assert.deepEqual(rows.map(row => [row.id, row.updatedAt]), [["newer", 2000], ["older", 1000]]);
  assert.notEqual(rows[0].workspaceDir, rows[1].workspaceDir);
  for (const row of rows) {
    assert.deepEqual(Object.keys(row).sort(), ["id", "title", "workspaceDir", "updatedAt", "pinnedAt"].sort());
  }
  // 旧调用未注入存储时兼容读取，但不能假装已经保存置顶。
  const bare = createSessionService(s.sessions, () => assert.fail("不能创建Agent"));
  assert.equal((await bare.listSessions())[1].pinnedAt, null);
  await assert.rejects(bare.setSessionPinned("older", true), /尚未配置会话状态存储/);
});

test("无效参数、已丢失历史及未发送空会话均拒绝，不新建状态", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  for (const value of [undefined, null, 1, "true"]) {
    await assert.rejects(s.service.setSessionPinned("a", value), /置顶状态无效/);
  }
  for (const id of [undefined, null, "", " ", "../a", "missing"]) {
    await assert.rejects(s.service.setSessionPinned(id, true));
  }
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
  await s.store.saveDraft("empty", s.workspace, "未发送", 0);
  const before = await s.store.load("empty");
  await assert.rejects(s.service.setSessionPinned("empty", true), /未找到该历史对话/);
  assert.deepEqual(await s.store.load("empty"), before);
});

test("无目录或重复编号的历史拒绝置顶，不猜测归属", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "old", null);
  await assert.rejects(s.service.setSessionPinned("old", true), /缺少工作目录/);
  await writeHistory(s, "duplicate", s.workspace, 1000, "copy-one");
  await writeHistory(s, "duplicate", s.workspace, 2000, "copy-two");
  await assert.rejects(s.service.setSessionPinned("duplicate", true), /多份相同编号/);
  await assert.rejects(fs.stat(s.directory), { code: "ENOENT" });
});

test("状态与历史目录不一致时拒绝读取置顶或覆盖记录", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.saveDraft("a", path.join(s.root, "other"), "保留", 0);
  const file = path.join(s.directory, "a.json");
  const before = await fs.readFile(file, "utf8");
  await assert.rejects(s.service.listSessions(), /工作目录不匹配/);
  await assert.rejects(s.service.setSessionPinned("a", true), /工作目录不匹配/);
  assert.equal(await fs.readFile(file, "utf8"), before);
});

test("损坏状态明确报错，列表与置顶都不静默当成未置顶", async (t) => {
  const s = await setup(t);
  await writeHistory(s, "a");
  await s.store.saveDraft("a", s.workspace, "保留", 0);
  const file = path.join(s.directory, "a.json");
  await fs.writeFile(file, "{broken");
  await assert.rejects(s.service.listSessions(), /记录损坏/);
  await assert.rejects(s.service.setSessionPinned("a", true), /记录损坏/);
  assert.equal(await fs.readFile(file, "utf8"), "{broken");
});

test("写入失败保留原状态和历史，清理临时文件后可重试", async (t) => {
  const s = await setup(t);
  const history = await writeHistory(s, "a");
  await s.store.saveDraft("a", s.workspace, "保留输入", 0);
  const file = path.join(s.directory, "a.json");
  const before = await fs.readFile(file, "utf8");
  const rename = t.mock.method(fs, "rename", async () => { throw new Error("模拟置顶写入失败"); });
  try {
    await assert.rejects(s.service.setSessionPinned("a", true), /模拟置顶写入失败/);
    assert.equal(await fs.readFile(file, "utf8"), before);
    assert.deepEqual(await fs.readdir(s.directory), ["a.json"]);
    assert.equal(await fs.readFile(history.file, "utf8"), history.content);
  } finally {
    rename.mock.restore();
  }
  assert.equal(typeof (await s.service.setSessionPinned("a", true)).pinnedAt, "number");
});
```

## 4. 验证

在项目目录依次运行：

```bash
node --check src/main/services/session-service.js
node --check tests/unit/session-list.test.js
node --check tests/unit/session-pin.test.js

node --test \
  tests/unit/session-pin.test.js \
  tests/unit/session-list.test.js \
  tests/unit/session-state-store.test.js \
  tests/unit/session-state-list.test.js \
  tests/unit/composer-draft-service.test.js \
  tests/unit/session-service.test.js \
  tests/unit/project-open.test.js
```

候选验证：临时副本`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-session-pin-candidate-gppfq6p3`。先在未改服务时运行10项新专项，10项均失败，确实检测到缺少接口/元数据；加入候选后，三个脚本语法检查及上述7文件49项全部通过。日志为副本中的`pin-before.log`、`pin-after.log`。

本轮只在临时副本修改服务与测试；实际项目仅新增本指南并更新交接文档。检查不读取真实`.env`、配置或会话，不请求模型；已有`session-service.test.js`的默认创建检查使用独立进程和临时配置。候选通过不等于使用者实际手写文件已经通过。

完成后反馈“做完了”或贴出失败输出；下一轮先核对实际实现，再提供置顶IPC/预加载及页面接线建议。置顶页面尚未完成，归档尚未实施，不把这一小步记成完整会话组织功能。
