const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const { createChatService } = require("../../src/main/services/chat-service.js");
const {
  createProposalApplyService,
} = require("../../src/main/services/proposal-apply-service.js");

async function setup(t, applyEdit) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-save-service-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const filename = path.join(workspace, "example.js");
  await writeFile(filename, "before\n");

  const { createProposeEditTool } = await import(
    "../../src/main/tools/propose-edit.mjs"
  );
  const result = await createProposeEditTool(workspace).execute("test", {
    path: "example.js",
    oldText: "before",
    newText: "after",
  });

  let sessionId = "session-a";
  let proposal;
  const notices = [];
  const sessionService = {
    getSession: async () => ({ sessionId }),
    async recordWorkspaceEdit(draft) {
      notices.push(draft);
    },
  };
  const chatService = createChatService(
    sessionService,
    async () => async (_session, _text, _onText, onToolEvent) => {
      onToolEvent({
        type: "end",
        name: "propose_workspace_edit",
        isError: false,
        proposal: result.details,
      });
    },
  );

  // 模拟工具事件登记，不发送真实模型请求。
  await chatService.send("生成草稿", () => {}, (event) => {
    proposal = event.proposal;
  });

  return {
    filename,
    proposal,
    chatService,
    notices,
    sessionService,
    service: createProposalApplyService(
      workspace, chatService, sessionService, applyEdit,
    ),
    switchSession: () => { sessionId = "session-b"; },
  };
}

test("保存登记草稿后更新状态，并拒绝再次保存", async (t) => {
  const { filename, proposal, chatService, service, notices } = await setup(t);

  assert.deepEqual(await service.apply(proposal.id), {
    id: proposal.id,
    path: "example.js",
    written: true,
    contextRecorded: true,
  });
  assert.equal(await readFile(filename, "utf8"), "after\n");
  assert.equal((await chatService.getProposal(proposal.id)).written, true);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].id, proposal.id);
  await assert.rejects(service.apply(proposal.id), /已经保存/);
  assert.equal(notices.length, 1);
});

test("其他会话的草稿不会进入文件写入", async (t) => {
  let calls = 0;
  const { filename, proposal, service, switchSession } = await setup(
    t,
    async () => { calls += 1; },
  );
  switchSession();

  await assert.rejects(service.apply(proposal.id), /当前会话中不存在/);
  assert.equal(calls, 0);
  assert.equal(await readFile(filename, "utf8"), "before\n");
});

test("写入失败不标记成功，之后可以重新保存", async (t) => {
  let calls = 0;
  const { filename, proposal, chatService, service } = await setup(
    t,
    async (workspace, draft) => {
      calls += 1;
      if (calls === 1) throw new Error("模拟写入失败");
      const { applyWorkspaceEdit } = await import(
        "../../src/main/workspace/apply-workspace-edit.mjs"
      );
      return applyWorkspaceEdit(workspace, draft);
    },
  );

  await assert.rejects(service.apply(proposal.id), /模拟写入失败/);
  assert.equal((await chatService.getProposal(proposal.id)).written, false);
  assert.equal(await readFile(filename, "utf8"), "before\n");

  await service.apply(proposal.id);
  assert.equal((await chatService.getProposal(proposal.id)).written, true);
  assert.equal(await readFile(filename, "utf8"), "after\n");
});


test("会话记录失败时仍返回文件已保存，且不允许重复写入", async (t) => {
  const { filename, proposal, chatService, service, sessionService } =
    await setup(t);
  sessionService.recordWorkspaceEdit = async () => {
    throw new Error("模拟会话记录失败");
  };

  const result = await service.apply(proposal.id);

  assert.equal(result.written, true);
  assert.equal(result.contextRecorded, false);
  assert.match(result.warning, /文件已保存/);
  assert.match(result.warning, /模拟会话记录失败/);
  assert.equal(await readFile(filename, "utf8"), "after\n");
  assert.equal((await chatService.getProposal(proposal.id)).written, true);
  await assert.rejects(service.apply(proposal.id), /已经保存/);
});
