const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  rm,
} = require("node:fs/promises");
const {
  createProposalReviewService,
} = require("../../src/main/services/proposal-review-service.js");
const {
  createProposalApplyService,
} = require("../../src/main/services/proposal-apply-service.js");

async function setup(t, kind) {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-proposal-workspace-"),
  );
  t.after(() => rm(base, { recursive: true, force: true }));

  const first = path.join(base, "first");
  const second = path.join(base, "second");
  await mkdir(first);
  await mkdir(second);
  await writeFile(path.join(first, "edit.txt"), "before\n");
  await writeFile(path.join(second, "edit.txt"), "before\n");

  let current = first;
  let failRead = false;
  let draft;
  let beginCalls = 0;
  const records = [];

  const chat = {
    async getProposal() {
      return draft;
    },
    beginProposalApply() {
      beginCalls += 1;
    },
    cancelProposalApply() {},
    markProposalWritten() {
      draft.written = true;
    },
  };

  const readWorkspace = async () => {
    if (failRead) throw new Error("读取当前目录失败");
    return current;
  };

  const review = createProposalReviewService(readWorkspace, chat);
  const apply = createProposalApplyService(readWorkspace, chat, {
    async recordWorkspaceEdit(proposal) {
      records.push(proposal);
    },
  });

  function select(directory, label) {
    current = directory;
    draft = {
      id: label,
      sessionId: "session-" + label,
      kind,
      path: kind === "create-proposal" ? "new.txt" : "edit.txt",
      content: label,
      oldText: "before",
      newText: label,
      baseTextHash: createHash("sha256")
        .update("before\n")
        .digest("hex"),
      written: false,
      applying: false,
    };
  }

  select(first, "first");

  return {
    first,
    second,
    review,
    apply,
    records,
    select,
    getDraft: () => draft,
    failReading: () => { failRead = true; },
    getBeginCalls: () => beginCalls,
  };
}

for (const kind of ["edit-proposal", "create-proposal"]) {
  test(`${kind} 审阅和保存跟随当前目录，其他目录保持原状`, async (t) => {
    const state = await setup(t, kind);
    const name = kind === "create-proposal" ? "new.txt" : "edit.txt";
    const suffix = kind === "create-proposal" ? "" : "\n";

    await state.review.review("first");
    await state.apply.apply("first");

    assert.equal(
      await readFile(path.join(state.first, name), "utf8"),
      "first" + suffix,
    );

    if (kind === "create-proposal") {
      await assert.rejects(
        readFile(path.join(state.second, name)),
        { code: "ENOENT" },
      );
    } else {
      assert.equal(
        await readFile(path.join(state.second, name), "utf8"),
        "before\n",
      );
    }

    // 复用同一组服务，模拟当前会话改为另一个目录。
    state.select(state.second, "second");
    await state.review.review("second");
    await state.apply.apply("second");

    assert.equal(
      await readFile(path.join(state.second, name), "utf8"),
      "second" + suffix,
    );
    assert.equal(
      await readFile(path.join(state.first, name), "utf8"),
      "first" + suffix,
    );
    assert.equal(state.records.length, 2);
  });
}

test("读取目录失败时不写文件，也不将草稿标记为正在保存", async (t) => {
  const state = await setup(t, "edit-proposal");
  state.failReading();

  await assert.rejects(
    state.review.review("first"),
    /读取当前目录失败/,
  );
  await assert.rejects(
    state.apply.apply("first"),
    /读取当前目录失败/,
  );

  assert.equal(state.getBeginCalls(), 0);
  assert.equal(state.getDraft().written, false);
  assert.equal(state.records.length, 0);
  assert.equal(
    await readFile(path.join(state.first, "edit.txt"), "utf8"),
    "before\n",
  );
});