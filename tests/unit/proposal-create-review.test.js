const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");
const {
  mkdtemp, mkdir, writeFile, readFile, readdir, symlink, unlink, rm,
} = require("node:fs/promises");
const {
  createProposalReviewService,
} = require("../../src/main/services/proposal-review-service.js");

async function setup(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-create-review-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const workspace = path.join(root, "workspace");
  await mkdir(workspace);

  const proposal = {
    id: "create-1",
    sessionId: "session-a",
    kind: "create-proposal",
    path: "hello.js",
    content: 'console.log("你好");\n',
    written: false,
  };
  const service = createProposalReviewService(workspace, {
    async getProposal(id) {
      assert.equal(id, proposal.id);
      return { ...proposal };
    },
  });
  return { root, workspace, proposal, service };
}

test("审阅返回完整新建草稿，保留中文和空文件，不写工作目录", async (t) => {
  const { workspace, proposal, service } = await setup(t);
  for (const content of [proposal.content, ""]) {
    proposal.content = content;
    assert.deepEqual(await service.review(proposal.id), proposal);
    assert.deepEqual(await readdir(workspace), []);
  }
});

test("生成草稿后文件被占用，审阅拒绝且保留现有内容", async (t) => {
  const { workspace, proposal, service } = await setup(t);
  const target = path.join(workspace, proposal.path);
  await writeFile(target, "其他程序创建的内容");
  await assert.rejects(service.review(proposal.id), /已经存在/);
  assert.equal(await readFile(target, "utf8"), "其他程序创建的内容");
});

test("目录和失效符号链接也属于已占用目标", async (t) => {
  const { workspace, proposal, service } = await setup(t);
  await mkdir(path.join(workspace, "occupied"));
  await symlink("missing.txt", path.join(workspace, "dangling.txt"));
  for (const filename of ["occupied", "dangling.txt"]) {
    proposal.path = filename;
    await assert.rejects(service.review(proposal.id), /已经存在/);
  }
});

test("审阅复用路径策略，拒绝隐藏路径、目录外路径和缺失父目录", async (t) => {
  const { proposal, service } = await setup(t);
  for (const [filename, expected] of [
    [".env", /不对 Agent 开放/],
    ["../outside.txt", /工作目录之外/],
    ["missing/hello.js", /ENOENT/],
  ]) {
    proposal.path = filename;
    await assert.rejects(service.review(proposal.id), expected);
  }
});

test("父目录符号链接改指向工作目录外后拒绝再次审阅", async (t) => {
  const { root, workspace, proposal, service } = await setup(t);
  const inside = path.join(workspace, "inside");
  const shortcut = path.join(workspace, "shortcut");
  await mkdir(inside);
  await symlink(inside, shortcut);
  proposal.path = "shortcut/hello.js";
  await service.review(proposal.id);

  // 模拟第一次检查后，其他程序替换了父目录链接。
  await unlink(shortcut);
  await symlink(root, shortcut);
  await assert.rejects(service.review(proposal.id), /工作目录之外/);
  assert.deepEqual(await readdir(inside), []);
});

test("拒绝已保存、保存未确认和未知类型草稿", async (t) => {
  const { proposal, service } = await setup(t);
  proposal.written = true;
  await assert.rejects(service.review(proposal.id), /已经保存/);

  proposal.written = false;
  proposal.applying = true;
  await assert.rejects(service.review(proposal.id), /未确认完成/);

  proposal.applying = false;
  proposal.kind = "unknown-proposal";
  await assert.rejects(service.review(proposal.id), /不支持审阅/);
});