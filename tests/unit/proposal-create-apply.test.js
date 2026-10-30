const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, mkdir, writeFile, readFile, readdir, rm } = require("node:fs/promises");
const { createProposalStorage } = require("../../src/main/storage/proposal-storage.js");
const { createProposalStore } = require("../../src/main/services/proposal-store.js");
const { createChatService } = require("../../src/main/services/chat-service.js");
const { createSessionService } = require("../../src/main/services/session-service.js");
const { createProposalApplyService } = require("../../src/main/services/proposal-apply-service.js");
const { toHistory } = require("../../src/main/adapters/message-adapter.js");

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-create-service-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const workspace = path.join(root, "workspace");
  await mkdir(workspace);

  const storage = createProposalStorage(path.join(root, "drafts"));
  const store = createProposalStore(storage);
  const records = [];

  const session = {
    sessionId: "session-a",
    async sendCustomMessage(message, options) {
      records.push({ message, options });
    },
    async prompt() {
      assert.fail("保存事实记录不应请求模型");
    },
  };

  const sessionService = createSessionService(
    path.join(root, "sessions"), async () => session,
  );
  const chat = createChatService(sessionService, undefined, store);
  const proposal = store.add(session.sessionId, {
    kind: "create-proposal",
    path: "hello.txt",
    content: "你好\r\n",
    written: false,
  });
  const service = createProposalApplyService(workspace, chat, sessionService);

  return {
    workspace, storage, store, records, session, sessionService, chat, proposal, service,
  };
}

test("保存中文和空文件，记录新建事实并恢复为已保存状态", async (t) => {
  const { workspace, storage, store, records, proposal, service } = await setup(t);
  const empty = store.add("session-a", {
    kind: "create-proposal", path: "empty.txt", content: "", written: false,
  });

  for (const draft of [proposal, empty]) {
    assert.deepEqual(await service.apply(draft.id), {
      id: draft.id, path: draft.path, written: true, contextRecorded: true,
    });
    assert.equal(await readFile(path.join(workspace, draft.path), "utf8"), draft.content);

    const { message, options } = records.at(-1);
    assert.equal(message.customType, "workspace-create-applied");
    assert.equal(message.display, true);
    assert.deepEqual(options, { triggerTurn: false });

    assert.deepEqual(JSON.parse(message.content.split("\n")[2]), {
      proposalId: draft.id, path: draft.path, operation: "create", content: draft.content,
    });
    assert.deepEqual(toHistory([{ role: "custom", ...message }]), [
      { role: "status", text: message.content },
    ]);

    assert.equal(createProposalStore(storage).get("session-a", draft.id).written, true);
    await assert.rejects(service.apply(draft.id), /已经保存/);
  }

  assert.equal(records.length, 2);
  assert.deepEqual(createProposalStore(storage).listPending("session-a"), []);
  assert.deepEqual((await readdir(workspace)).sort(), ["empty.txt", "hello.txt"]);
});

test("目标被占用时保留原文件，并恢复可操作的草稿状态", async (t) => {
  const { workspace, storage, records, proposal, service } = await setup(t);
  const filename = path.join(workspace, proposal.path);

  await writeFile(filename, "其他程序创建的内容");
  await assert.rejects(service.apply(proposal.id), /已经存在/);

  const restored = createProposalStore(storage).get("session-a", proposal.id);
  assert.equal(restored.written, false);
  assert.equal(restored.applying, false);
  assert.equal(await readFile(filename, "utf8"), "其他程序创建的内容");
  assert.equal(records.length, 0);
  assert.deepEqual(await readdir(workspace), [proposal.path]);
});

test("保存开始状态落盘失败时不创建文件", async (t) => {
  const { workspace, storage, store, records, proposal, service } = await setup(t);

  t.mock.method(storage, "save", () => {
    throw new Error("模拟开始状态落盘失败");
  });

  await assert.rejects(service.apply(proposal.id), /模拟开始状态落盘失败/);
  assert.equal(store.get("session-a", proposal.id).applying, undefined);
  assert.equal(records.length, 0);
  assert.deepEqual(await readdir(workspace), []);
});

test("完成状态落盘失败时返回已保存警告，重启后阻止直接重试", async (t) => {
  const { workspace, storage, proposal, service } = await setup(t);
  const save = storage.save.bind(storage);

  t.mock.method(storage, "save", (id, drafts) => {
    if (drafts.some((draft) => draft.written)) {
      throw new Error("模拟完成状态落盘失败");
    }
    save(id, drafts);
  });

  const result = await service.apply(proposal.id);

  assert.equal(result.written, true);
  assert.equal(result.contextRecorded, true);
  assert.match(result.warning, /模拟完成状态落盘失败/);
  assert.equal(await readFile(path.join(workspace, proposal.path), "utf8"), proposal.content);
  await assert.rejects(service.apply(proposal.id), /已经保存/);

  const restarted = createProposalStore(storage);
  assert.throws(() => restarted.beginApply("session-a", proposal.id), /未确认完成/);
});

test("会话记录失败时保留保存结果，并合并底层清理警告", async (t) => {
  const { workspace, session, sessionService, chat, proposal } = await setup(t);

  session.sendCustomMessage = async () => {
    throw new Error("模拟会话记录失败");
  };

  const { applyWorkspaceCreate } = await import(
    "../../src/main/workspace/apply-workspace-create.mjs"
  );

  // 使用真实保存，仅模拟它返回一条清理警告，验证两种警告不会互相覆盖。
  const service = createProposalApplyService(
    workspace, chat, sessionService, undefined,
    async (directory, draft) => ({
      ...await applyWorkspaceCreate(directory, draft),
      warning: "文件已保存，但模拟临时文件清理失败",
    }),
  );

  const result = await service.apply(proposal.id);

  assert.equal(result.written, true);
  assert.equal(result.contextRecorded, false);
  assert.match(result.warning, /模拟临时文件清理失败/);
  assert.match(result.warning, /模拟会话记录失败/);
  assert.equal(await readFile(path.join(workspace, proposal.path), "utf8"), proposal.content);
  await assert.rejects(service.apply(proposal.id), /已经保存/);
});

test("切换会话后拒绝保存其他会话的新建草稿", async (t) => {
  const { workspace, records, session, proposal, service } = await setup(t);

  session.sessionId = "session-b";

  await assert.rejects(service.apply(proposal.id), /当前会话中不存在/);
  assert.equal(records.length, 0);
  assert.deepEqual(await readdir(workspace), []);
});

test("未知类型在登记保存开始状态前被拒绝", async (t) => {
  const { workspace, store, records, chat, proposal, service } = await setup(t);

  t.mock.method(chat, "getProposal", async () => ({
    ...proposal, kind: "unknown-proposal",
  }));

  await assert.rejects(service.apply(proposal.id), /不支持保存该草稿类型/);
  assert.equal(store.get("session-a", proposal.id).applying, undefined);
  assert.equal(records.length, 0);
  assert.deepEqual(await readdir(workspace), []);
});

test("历史仍忽略隐藏的新建记录和未知的自定义消息", () => {
  assert.deepEqual(toHistory([
    { role: "custom", customType: "workspace-create-applied", display: false, content: "隐藏" },
    { role: "custom", customType: "unknown", display: true, content: "未知" },
  ]), []);
});