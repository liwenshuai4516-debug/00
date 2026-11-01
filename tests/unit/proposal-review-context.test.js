const { test } = require("node:test");
const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const path = require("node:path");
const os = require("node:os");
const { mkdtemp, writeFile, readFile, rm } = require("node:fs/promises");
const {
  createProposalReviewService,
} = require("../../src/main/services/proposal-review-service.js");

const cases = [
  {
    name: "行内替换保留前后缀，仅包含前后各两行上下文",
    source: "头一\n头二\n前一\n前二\nconst value = 旧值;\n后一\n后二\n尾\n",
    oldText: "旧值",
    newText: "新值\n下一行",
    review: {
      startLine: 3,
      oldText: "前一\n前二\nconst value = 旧值;\n后一\n后二\n",
      newText: "前一\n前二\nconst value = 新值\n下一行;\n后一\n后二\n",
    },
  },
  {
    name: "删除跨行片段时不额外包含下一行",
    source: "a\nb\n旧一\n旧二\nc\nd\ne\n",
    oldText: "旧一\n旧二\n",
    newText: "",
    review: {
      startLine: 1,
      oldText: "a\nb\n旧一\n旧二\nc\nd\n",
      newText: "a\nb\nc\nd\n",
    },
  },
  {
    name: "保留 BOM、中文、空格、Tab 与混合换行",
    source: "\uFEFF头\r\n 旧 \t\r\n尾\r",
    oldText: "旧",
    newText: "新",
    review: {
      startLine: 1,
      oldText: "\uFEFF头\r\n 旧 \t\r\n尾\r",
      newText: "\uFEFF头\r\n 新 \t\r\n尾\r",
    },
  },
  {
    name: "替换从 CRLF 内部开始时仍展示完整行",
    source: "A\r\nB\r\nC",
    oldText: "\nB",
    newText: "\nX\n",
    review: {
      startLine: 1,
      oldText: "A\r\nB\r\nC",
      newText: "A\r\nX\n\r\nC",
    },
  },
  {
    name: "删除 CR 换行后准确展示合并行",
    source: "a\rb\rc",
    oldText: "a\r",
    newText: "a",
    review: {
      startLine: 1,
      oldText: "a\rb\rc",
      newText: "ab\rc",
    },
  },
  {
    name: "删除整个文件后正文为空，不制造占位字符",
    source: "全部\r\n",
    oldText: "全部\r\n",
    newText: "",
    review: {
      startLine: 1,
      oldText: "全部\r\n",
      newText: "",
    },
  },
  {
    name: "末行补换行时起始行准确且保留无换行原文",
    source: "一\n二\n三\n四\n旧",
    oldText: "旧",
    newText: "新\n",
    review: {
      startLine: 3,
      oldText: "三\n四\n旧",
      newText: "三\n四\n新\n",
    },
  },
  {
    name: "连续空行与仅空白的新行均按原样保留",
    source: "首\n\n\n末\n",
    oldText: "\n\n末",
    newText: "\t  \n末",
    review: {
      startLine: 1,
      oldText: "首\n\n\n末\n",
      newText: "首\n\t  \n末\n",
    },
  },
];

for (const entry of cases) {
  test(entry.name, async (t) => {
    const workspace = await mkdtemp(path.join(os.tmpdir(), "agent-review-lines-"));
    t.after(() => rm(workspace, { recursive: true, force: true }));

    const filename = path.join(workspace, "example.txt");
    await writeFile(filename, entry.source, "utf8");

    const proposal = {
      id: "edit-1",
      kind: "edit-proposal",
      path: "example.txt",
      oldText: entry.oldText,
      newText: entry.newText,
      baseTextHash: createHash("sha256").update(entry.source, "utf8").digest("hex"),
      written: false,
    };
    const original = { ...proposal };

    const service = createProposalReviewService(workspace, {
      // 故意返回原对象，确认审阅不会把上下文写回草稿。
      async getProposal() {
        return proposal;
      },
    });

    const reviewed = await service.review(proposal.id);

    assert.deepEqual(reviewed, { ...original, review: entry.review });
    assert.deepEqual(proposal, original);
    assert.equal(await readFile(filename, "utf8"), entry.source);
  });
}
