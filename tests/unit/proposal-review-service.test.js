const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp,
  writeFile,
  readFile,
  rm,
} = require("node:fs/promises");
const {
  createProposalReviewService,
} = require("../../src/main/services/proposal-review-service.js");

async function setup(t) {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-review-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));

  const filename = path.join(workspace, "example.js");
  const source = 'const title = "旧标题";\n';
  await writeFile(filename, source);

  const proposal = {
    id: "proposal-1",
    sessionId: "session-a",
    kind: "edit-proposal",
    path: "example.js",
    oldText: "旧标题",
    newText: "新标题",
    baseTextHash: createHash("sha256").update(source, "utf8").digest("hex"),
    written: false,
  };

  const service = createProposalReviewService(workspace, {
    async getProposal(id) {
      assert.equal(id, proposal.id);
      return { ...proposal };
    },
  });

  return { workspace, filename, source, proposal, service };
}

test("文件未变化时返回草稿，且不写入文件", async (t) => {
  const { filename, source, proposal, service } = await setup(t);

  assert.deepEqual(await service.review(proposal.id), proposal);
  assert.equal(await readFile(filename, "utf8"), source);
});

test("文件其他位置变化时也拒绝旧草稿", async (t) => {
  const { filename, source, proposal, service } = await setup(t);

  // 待替换文字没有变化，但文件整体已经改变。
  await writeFile(filename, source + "// 编辑器新增内容\n");

  await assert.rejects(
    service.review(proposal.id),
    /文件已发生变化/,
  );
});

test("不能唯一定位原文时拒绝草稿", async (t) => {
  const { proposal, service } = await setup(t);
  proposal.oldText = "不存在的内容";

  await assert.rejects(
    service.review(proposal.id),
    /不能唯一定位原文/,
  );
});

test("当前会话无法取得草稿时直接拒绝审阅", async () => {
  const service = createProposalReviewService(os.tmpdir(), {
    async getProposal() {
      throw new Error("当前会话中不存在该修改草稿。");
    },
  });

  await assert.rejects(
    service.review("other-session-proposal"),
    /当前会话中不存在/,
  );
});