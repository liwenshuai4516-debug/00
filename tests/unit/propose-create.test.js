const { test } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const os = require("node:os");

const {
  mkdtemp,
  mkdir,
  writeFile,
  readdir,
  rm,
} = require("node:fs/promises");

const {
  createProposalStore,
} = require("../../src/main/services/proposal-store.js");

const {
  createProposalStorage,
} = require("../../src/main/storage/proposal-storage.js");

async function setup(t) {
  const base = await mkdtemp(
    path.join(os.tmpdir(), "agent-create-draft-"),
  );

  t.after(() => rm(base, {
    recursive: true,
    force: true,
  }));

  const workspace = path.join(base, "workspace");
  await mkdir(workspace);

  const { createProposeCreateTool } = await import(
    "../../src/main/tools/propose-create.mjs"
  );

  return {
    workspace,
    tool: createProposeCreateTool(workspace),
    storage: createProposalStorage(
      path.join(base, "proposals"),
    ),
  };
}

function draft(content = "新文件内容\n") {
  return {
    kind: "create-proposal",
    path: "new.txt",
    content,
    written: false,
  };
}

test("生成新建草稿，保留中文与缩进，不创建工作文件", async (t) => {
  const { workspace, tool } = await setup(t);
  await mkdir(path.join(workspace, "src"));

  const content = "说明\n  第二行\n";
  const result = await tool.execute("call-1", {
    path: "src/new.txt",
    content,
  });

  assert.deepEqual(result.details, {
    ...draft(content),
    path: "src/new.txt",
  });

  assert.match(result.content[0].text, /尚未写入文件/);

  assert.deepEqual(
    await readdir(path.join(workspace, "src")),
    [],
  );
});

test("允许空文件和恰好 32 KiB 的文本", async (t) => {
  const { tool } = await setup(t);

  for (const content of ["", "a".repeat(32 * 1024)]) {
    const result = await tool.execute("call", {
      path: "new.txt",
      content,
    });

    assert.equal(result.details.content, content);
  }
});

test("按 UTF-8 字节数拒绝超限内容，并拒绝空字节或非文本", async (t) => {
  const { tool } = await setup(t);

  for (const content of [
    "a".repeat(32769),
    "中".repeat(10923),
  ]) {
    await assert.rejects(
      tool.execute("call", {
        path: "new.txt",
        content,
      }),
      /超过 32 KiB/,
    );
  }

  for (const content of [42, null, "a\0b"]) {
    await assert.rejects(
      tool.execute("call", {
        path: "new.txt",
        content,
      }),
      /必须是文本/,
    );
  }
});

test("工具复用路径约束，拒绝覆盖、隐藏路径和目录外路径", async (t) => {
  const { workspace, tool } = await setup(t);

  await writeFile(
    path.join(workspace, "existing.txt"),
    "原文",
  );

  for (const filename of [
    "existing.txt",
    ".env",
    "../outside.txt",
  ]) {
    await assert.rejects(
      tool.execute("call", {
        path: filename,
        content: "新内容",
      }),
      /已经存在|不对 Agent 开放|工作目录之外/,
    );
  }
});

test("调用前已取消时不生成草稿", async (t) => {
  const { tool } = await setup(t);
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    tool.execute(
      "call",
      { path: "new.txt", content: "内容" },
      controller.signal,
    ),
    { name: "AbortError" },
  );
});

test("新建与修改草稿能共同恢复，新建草稿可按会话隔离并放弃", async (t) => {
  const { workspace, tool, storage } = await setup(t);

  const generated = await tool.execute("call", {
    path: "new.txt",
    content: "内容\n",
  });

  const store = createProposalStore(storage);

  const created = store.add("session-a", {
    ...generated.details,

    // 模拟工具结果携带不应被采用的字段。
    id: "forged",
    sessionId: "other",
    internalData: "不保留",
  });

  const edited = store.add("session-a", {
    kind: "edit-proposal",
    path: "existing.txt",
    oldText: "before",
    newText: "after",
    baseTextHash: "a".repeat(64),
    written: false,
  });

  assert.notEqual(created.id, "forged");
  assert.equal(created.sessionId, "session-a");
  assert.equal(created.internalData, undefined);

  created.content = "篡改返回值";

  // 新实例只能从快照恢复，验证两类记录可以共存。
  const restored = createProposalStore(storage);

  assert.equal(
    restored.get("session-a", created.id).content,
    "内容\n",
  );

  assert.equal(
    restored.get("session-a", edited.id).oldText,
    "before",
  );

  assert.throws(
    () => restored.get("session-b", created.id),
    /不存在/,
  );

  restored.discard("session-a", created.id);

  const again = createProposalStore(storage);

  assert.deepEqual(again.listPending("session-a"), [
    { id: edited.id, path: edited.path },
  ]);

  assert.deepEqual(await readdir(workspace), []);
});

test("登记和恢复时都拒绝无效的新建草稿", async (t) => {
  const { storage } = await setup(t);

  const invalid = [
    { ...draft(), content: null },
    draft("a\0b"),
    draft("中".repeat(10923)),
    { ...draft(), path: "" },
    { ...draft(), kind: "unknown" },
  ];

  for (const proposal of invalid) {
    assert.throws(
      () => createProposalStore().add("session-a", proposal),
      /无效/,
    );

    storage.save("session-a", [
      {
        ...proposal,
        id: "p-1",
        sessionId: "session-a",
      },
    ]);

    assert.throws(
      () => createProposalStore(storage).listPending("session-a"),
      /字段无效/,
    );
  }
});

test("新建草稿落盘失败不公布，恢复存储后允许重试", () => {
  let fail = true;

  const store = createProposalStore({
    load: () => [],

    save() {
      if (fail) {
        throw new Error("模拟快照写入失败");
      }
    },
  });

  assert.throws(
    () => store.add("session-a", draft()),
    /模拟快照写入失败/,
  );

  assert.deepEqual(store.listPending("session-a"), []);

  fail = false;

  const saved = store.add("session-a", draft());

  assert.equal(
    store.get("session-a", saved.id).content,
    "新文件内容\n",
  );
});