const { test } = require("node:test");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const {
  createWorkspaceChangesService,
  parseNumstat,
  displayPath,
} = require("../../src/main/services/workspace-changes-service.js");

function gitAvailable() {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const GIT = gitAvailable();

function runGit(cwd, args) {
  execFileSync("git", ["-c", "user.email=test@example.com", "-c", "user.name=test", ...args], {
    cwd,
    stdio: "ignore",
  });
}

async function makeTempRoot(name) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `wcs-${name}-`));
  return fs.realpath(root);
}

async function makeRepo(root) {
  const repo = path.join(root, "repo");
  await fs.mkdir(repo);
  runGit(repo, ["init", "-q"]);
  await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\n");
  await fs.writeFile(path.join(repo, "gone.txt"), "bye\n");
  runGit(repo, ["add", "-A"]);
  runGit(repo, ["commit", "-qm", "init"]);
  return repo;
}

test("git 仓库按轮次汇总改动并提供逐文件差异", { skip: !GIT }, async () => {
  const root = await makeTempRoot("git");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const repo = await makeRepo(root);
    const recording = await service.begin("session-a", repo);
    await recording.ready;

    await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo changed\nthree\nfour\n");
    await fs.writeFile(path.join(repo, "new.txt"), "hello\n");
    await fs.rm(path.join(repo, "gone.txt"));

    const summary = await service.finish(recording.id);
    assert.equal(summary.requestId, recording.id);
    assert.equal(summary.total, 3);
    assert.deepEqual(summary.files.map((file) => file.display), ["a.txt", "gone.txt", "new.txt"]);
    assert.deepEqual(
      summary.files.map((file) => [file.added, file.deleted]),
      [[2, 1], [0, 1], [1, 0]],
    );
    // 页面只拿展示路径，不接收主进程的绝对路径。
    assert.equal(summary.files.every((file) => !("path" in file)), true);

    const changed = summary.files.find((file) => file.display === "a.txt");
    const diff = await service.diff(recording.id, changed.index);
    assert.equal(diff.kind, "text");
    assert.equal(diff.added, 2);
    assert.equal(diff.deleted, 1);
    assert.equal(diff.hunks.length, 1);
    assert.deepEqual(diff.hunks[0].rows.map((row) => row.kind), [
      "equal", "remove", "add", "equal", "add",
    ]);

    const created = summary.files.find((file) => file.display === "new.txt");
    const createdDiff = await service.diff(recording.id, created.index);
    assert.equal(createdDiff.hunks[0].oldStart, 0);
    assert.equal(createdDiff.hunks[0].oldCount, 0);
    assert.equal(createdDiff.added, 1);
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("无 git 时只记录文件工具在写入前的捕获", async () => {
  const root = await makeTempRoot("plain");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "note.md"), "old\n");

    const recording = await service.begin("session-b", workspace);
    await recording.ready;
    await service.capture({
      sessionId: "session-b",
      cwd: workspace,
      toolName: "write",
      input: { path: "note.md" },
    });
    await fs.writeFile(path.join(workspace, "note.md"), "old\nnew\n");

    await service.capture({
      sessionId: "session-b",
      cwd: workspace,
      toolName: "write",
      input: { path: "created.md" },
    });
    await fs.writeFile(path.join(workspace, "created.md"), "x\n");

    const summary = await service.finish(recording.id);
    assert.deepEqual(summary.files.map((file) => file.display), ["created.md", "note.md"]);
    assert.deepEqual(summary.files.map((file) => [file.added, file.deleted]), [[1, 0], [1, 0]]);

    const diff = await service.diff(recording.id, summary.files[1].index);
    assert.deepEqual(diff.hunks[0].rows.map((row) => [row.kind, row.text]), [
      ["equal", "old"],
      ["add", "new"],
    ]);
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("没有改动时不生成文件，读取不存在的请求返回空", async () => {
  const root = await makeTempRoot("empty");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const recording = await service.begin("session-c", workspace);
    await recording.ready;
    const summary = await service.finish(recording.id);
    assert.deepEqual(summary.files, []);
    assert.equal(summary.total, 0);
    assert.equal(service.summary("missing"), null);
    assert.equal(await service.diff("missing", 0), null);
    assert.equal(await service.diff(recording.id, 99), null);
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("同一文件同时被 git 与写入捕获时只保留 git 条目", { skip: !GIT }, async () => {
  const root = await makeTempRoot("dedupe");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const repo = await makeRepo(root);
    const recording = await service.begin("session-d", repo);
    await recording.ready;
    await service.capture({
      sessionId: "session-d",
      cwd: repo,
      toolName: "edit",
      input: { path: "a.txt" },
    });
    await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo\nthree\nfour\n");

    const summary = await service.finish(recording.id);
    assert.equal(summary.files.filter((file) => file.display === "a.txt").length, 1);
    assert.deepEqual([summary.files[0].added, summary.files[0].deleted], [1, 0]);
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("同一轮内重复捕获同一文件只保留第一次内容", async () => {
  const root = await makeTempRoot("repeat");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    await fs.writeFile(path.join(workspace, "a.txt"), "first\n");

    const recording = await service.begin("session-e", workspace);
    await recording.ready;
    await service.capture({ sessionId: "session-e", cwd: workspace, toolName: "edit", input: { path: "a.txt" } });
    await fs.writeFile(path.join(workspace, "a.txt"), "second\n");
    await service.capture({ sessionId: "session-e", cwd: workspace, toolName: "edit", input: { path: "a.txt" } });
    await fs.writeFile(path.join(workspace, "a.txt"), "third\n");

    const summary = await service.finish(recording.id);
    assert.equal(summary.files.length, 1);
    assert.deepEqual([summary.files[0].added, summary.files[0].deleted], [1, 1]);
    const diff = await service.diff(recording.id, 0);
    assert.equal(diff.hunks[0].rows[0].text, "first");
    assert.equal(diff.hunks[0].rows.at(-1).text, "third");
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("二进制文件不带行数，差异返回二进制状态", { skip: !GIT }, async () => {
  const root = await makeTempRoot("binary");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const repo = await makeRepo(root);
    const recording = await service.begin("session-f", repo);
    await recording.ready;
    await fs.writeFile(path.join(repo, "image.bin"), Buffer.from([0, 1, 2, 3]));
    const summary = await service.finish(recording.id);
    const file = summary.files.find((item) => item.display === "image.bin");
    assert.equal(file.binary, true);
    assert.deepEqual([file.added, file.deleted], [0, 0]);
    const diff = await service.diff(recording.id, file.index);
    assert.equal(diff.kind, "binary");
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("超过大小上限的捕获文件标记为过大，不读取内容", async () => {
  const root = await makeTempRoot("oversized");
  const service = createWorkspaceChangesService({ tempRoot: root, maxFileBytes: 64 });
  try {
    const workspace = path.join(root, "workspace");
    await fs.mkdir(workspace);
    const file = path.join(workspace, "big.txt");
    await fs.writeFile(file, "x".repeat(200));
    const recording = await service.begin("session-g", workspace);
    await recording.ready;
    await service.capture({ sessionId: "session-g", cwd: workspace, toolName: "write", input: { path: "big.txt" } });
    await fs.writeFile(file, "y".repeat(200));
    const summary = await service.finish(recording.id);
    assert.equal(summary.files[0].oversized, true);
    const diff = await service.diff(recording.id, 0);
    assert.equal(diff.kind, "oversized");
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("从子目录工作时保留上级仓库文件的相对展示路径", { skip: !GIT }, async () => {
  const root = await makeTempRoot("subdir");
  const service = createWorkspaceChangesService({ tempRoot: root });
  try {
    const repo = await makeRepo(root);
    const sub = path.join(repo, "sub");
    await fs.mkdir(sub);
    await fs.writeFile(path.join(sub, "inner.txt"), "a\n");
    runGit(repo, ["add", "-A"]);
    runGit(repo, ["commit", "-qm", "sub"]);
    const recording = await service.begin("session-h", sub);
    await recording.ready;
    await fs.writeFile(path.join(repo, "a.txt"), "one\ntwo changed\nthree\n");
    await fs.writeFile(path.join(sub, "inner.txt"), "a\nb\n");
    const summary = await service.finish(recording.id);
    assert.deepEqual(summary.files.map((file) => file.display), ["../a.txt", "inner.txt"]);
  } finally {
    service.dispose();
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("numstat 解析重命名与二进制记录", () => {
  assert.deepEqual(parseNumstat("1\t2\ta.txt\0-\t-\timage.png\0"), [
    { path: "a.txt", added: 1, deleted: 2, binary: false },
    { path: "image.png", added: 0, deleted: 0, binary: true },
  ]);
  assert.deepEqual(parseNumstat("0\t0\t\0old.txt\0new.txt\0"), [
    { path: "new.txt", oldPath: "old.txt", added: 0, deleted: 0, binary: false },
  ]);
});

test("展示路径在工作目录内使用相对路径，仓库外回退到绝对或 ~", () => {
  const cwd = "/work/project";
  assert.equal(displayPath(cwd, "/work/project/src/a.js", "/work/project"), "src/a.js");
  assert.equal(displayPath(cwd, "/work/project/../other/a.js", "/work/project"), "/work/other/a.js");
  assert.equal(displayPath(cwd, "/tmp/a.js", "/work/project"), "/tmp/a.js");
});
