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
  readdir,
  chmod,
  stat,
  symlink,
  rm,
} = require("node:fs/promises");

async function setup(t, source = 'const title = "旧标题";\n') {
  // 所有写入发生在临时目录，不修改真实项目文件。
  const base = await mkdtemp(path.join(os.tmpdir(), "agent-apply-"));
  t.after(() => rm(base, { recursive: true, force: true }));

  const workspace = path.join(base, "workspace");
  await mkdir(workspace);

  const filename = path.join(workspace, "example.js");
  await writeFile(filename, source);

  const { applyWorkspaceEdit } = await import(
    "../../src/main/workspace/apply-workspace-edit.mjs"
  );

  const proposal = {
    kind: "edit-proposal",
    path: "example.js",
    oldText: "旧标题",
    newText: "新标题",
    baseTextHash: createHash("sha256")
      .update(source, "utf8")
      .digest("hex"),
    written: false,
  };

  return {
    base,
    workspace,
    filename,
    source,
    proposal,
    apply: () => applyWorkspaceEdit(workspace, proposal),
  };
}

test("保存精确替换结果，保留权限且不遗留临时文件", async (t) => {
  const { workspace, filename, apply } = await setup(t);
  await chmod(filename, 0o640);

  assert.deepEqual(await apply(), {
    path: "example.js",
    written: true,
  });
  assert.equal(
    await readFile(filename, "utf8"),
    'const title = "新标题";\n',
  );
  assert.equal((await stat(filename)).mode & 0o777, 0o640);
  assert.deepEqual(await readdir(workspace), ["example.js"]);
});

test("保存后保留 UTF-8 BOM 和 CRLF 换行", async (t) => {
  const source = '\uFEFFconst title = "旧标题";\r\n// 第二行\r\n';
  const { filename, apply } = await setup(t, source);

  await apply();

  // 比较实际字节，避免只检查解码后的显示结果。
  assert.deepEqual(
    await readFile(filename),
    Buffer.from(source.replace("旧标题", "新标题"), "utf8"),
  );
});

test("文件变化后拒绝保存，并保留编辑器修改", async (t) => {
  const { workspace, filename, source, apply } = await setup(t);
  const changed = source + "// 编辑器新增内容\n";
  await writeFile(filename, changed);

  await assert.rejects(apply(), /文件已发生变化/);

  assert.equal(await readFile(filename, "utf8"), changed);
  assert.deepEqual(await readdir(workspace), ["example.js"]);
});

test("再次保存同一草稿时拒绝旧基线", async (t) => {
  const { filename, apply } = await setup(t);

  await apply();
  await assert.rejects(apply(), /文件已发生变化/);

  assert.equal(
    await readFile(filename, "utf8"),
    'const title = "新标题";\n',
  );
});

test("原文重叠出现时拒绝保存", async (t) => {
  const { filename, proposal, apply } = await setup(t, "aaa");
  proposal.oldText = "aa";
  proposal.newText = "b";

  await assert.rejects(apply(), /不能唯一定位原文/);
  assert.equal(await readFile(filename, "utf8"), "aaa");
});

test("拒绝隐藏文件、目录外路径和指向目录外的链接", async (t) => {
  const { base, workspace, proposal, apply } = await setup(t);
  const outside = path.join(base, "outside.txt");
  const hidden = path.join(workspace, ".env");

  await writeFile(outside, "目录外内容");
  await writeFile(hidden, "本地配置");
  await symlink(outside, path.join(workspace, "external.txt"));

  for (const file of [".env", "../outside.txt", "external.txt"]) {
    proposal.path = file;

    await assert.rejects(
      apply(),
      /不对 Agent 开放|工作目录之外/,
    );
  }

  assert.equal(await readFile(outside, "utf8"), "目录外内容");
  assert.equal(await readFile(hidden, "utf8"), "本地配置");
});

test("修改后超过大小限制时拒绝保存", async (t) => {
  const source = "X" + "a".repeat(32767);
  const { filename, proposal, apply } = await setup(t, source);
  proposal.oldText = "X";
  proposal.newText = "XX";

  await assert.rejects(apply(), /修改后的文本超过/);
  assert.equal(await readFile(filename, "utf8"), source);
});