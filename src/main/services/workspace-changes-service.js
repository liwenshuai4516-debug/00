// 每轮改动记录：轮次开始与结束各拍一次 git 工作树快照，文件工具在写入前捕获目标。
// 只把摘要与逐文件内容留在主进程内存和系统临时目录，不写入 Pi 会话历史。
const { execFile } = require("node:child_process");
const { createHash } = require("node:crypto");
const { copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat } = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { createLineDiff } = require("./line-diff.js");

const WRITE_TOOLS = new Set(["write", "edit"]);
const TEMP_PREFIX = "qa-ws-changes-";
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 100;
const GIT_TIMEOUT_MS = 30000;
const GIT_OUTPUT_LIMIT = 64 * 1024 * 1024;
const BINARY_SAMPLE = 8000;

function defaultExecGit(args, options) {
  const encoding = options.encoding ?? "utf8";
  return new Promise((resolve) => {
    execFile("git", args, {
      cwd: options.cwd,
      env: options.env,
      timeout: options.timeout ?? GIT_TIMEOUT_MS,
      maxBuffer: options.maxBuffer ?? GIT_OUTPUT_LIMIT,
      encoding,
      windowsHide: true,
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        code: error?.code ?? 0,
        stdout,
        stderr,
      });
    });
  });
}

function toPosix(value) {
  return value.split(path.sep).join("/");
}

function inside(root, target) {
  const relative = path.relative(root, target);
  if (relative === "" || path.isAbsolute(relative)) return relative === "";
  return relative !== ".." && !relative.startsWith(`..${path.sep}`);
}

// 相对于工作目录；同一仓库内位于工作目录之上时保留 ../，仓库外回退到 ~ 或绝对路径。
function displayPath(cwd, absoluteInput, repoRoot) {
  const absolute = path.resolve(absoluteInput);
  const relative = path.relative(cwd, absolute);
  if (relative !== "" && !path.isAbsolute(relative)) {
    if (!relative.startsWith("..")) return toPosix(relative);
    if (repoRoot && inside(repoRoot, absolute)) return toPosix(relative);
  }
  const home = os.homedir();
  if (absolute === home || absolute.startsWith(`${home}${path.sep}`)) {
    return `~/${toPosix(path.relative(home, absolute))}`;
  }
  return toPosix(absolute);
}

function isBinary(buffer) {
  return buffer.subarray(0, BINARY_SAMPLE).includes(0);
}

function parseNumstat(output) {
  const records = String(output).split("\0");
  if (records.at(-1) === "") records.pop();
  const entries = [];
  while (records.length > 0) {
    const record = records.shift();
    const first = record.indexOf("\t");
    const second = first < 0 ? -1 : record.indexOf("\t", first + 1);
    if (second < 0) throw new Error("numstat 记录格式无效。");
    const added = record.slice(0, first);
    const deleted = record.slice(first + 1, second);
    let target = record.slice(second + 1);
    let oldPath;
    if (target === "") {
      oldPath = records.shift();
      const renamed = records.shift();
      if (oldPath === undefined || renamed === undefined) throw new Error("numstat 重命名记录不完整。");
      target = renamed;
    }
    const binary = added === "-";
    entries.push({
      path: target,
      ...(oldPath === undefined ? {} : { oldPath }),
      added: binary ? 0 : Number(added),
      deleted: binary ? 0 : Number(deleted),
      binary,
    });
  }
  return entries;
}

function createWorkspaceChangesService(options = {}) {
  const execGit = options.execGit ?? defaultExecGit;
  const tempRoot = options.tempRoot ?? os.tmpdir();
  const maxFiles = Number.isInteger(options.maxFiles) && options.maxFiles > 0 ? options.maxFiles : MAX_FILES;
  const maxFileBytes = Number.isInteger(options.maxFileBytes) && options.maxFileBytes > 0
    ? options.maxFileBytes
    : MAX_FILE_BYTES;
  const maxRequests = Number.isInteger(options.maxRequests) && options.maxRequests > 0
    ? options.maxRequests
    : MAX_REQUESTS;

  const requests = new Map();
  const bySession = new Map();
  let counter = 0;
  let disposed = false;

  async function cleanupStale() {
    let names;
    try {
      names = await readdir(tempRoot);
    } catch {
      return;
    }
    const staleBefore = Date.now() - 24 * 60 * 60 * 1000;
    for (const name of names) {
      if (!name.startsWith(TEMP_PREFIX)) continue;
      const target = path.join(tempRoot, name);
      try {
        const info = await stat(target);
        if (info.mtimeMs < staleBefore) await rm(target, { recursive: true, force: true });
      } catch {
        // 并发清理或权限问题不影响本次运行。
      }
    }
  }
  void cleanupStale();

  function gitEnv(repo, extra = {}) {
    return {
      ...process.env,
      ...(repo.index ? { GIT_INDEX_FILE: repo.index } : {}),
      ...(repo.objects ? { GIT_OBJECT_DIRECTORY: repo.objects } : {}),
      ...(repo.alternates ? { GIT_ALTERNATE_OBJECT_DIRECTORIES: repo.alternates } : {}),
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      ...extra,
    };
  }

  async function resolveRepo(cwd) {
    const top = await execGit(["rev-parse", "--show-toplevel"], { cwd, timeout: 5000 });
    if (!top.ok) return null;
    const toplevel = String(top.stdout).trim();
    if (!toplevel) return null;
    // git 返回真实路径；统一 realpath 后再比较，避免 /var 与 /private/var 产生重复条目。
    const root = await realpath(toplevel).catch(() => toplevel);
    const objectsPath = await execGit(["rev-parse", "--git-path", "objects"], { cwd: root, timeout: 5000 });
    if (!objectsPath.ok) return null;
    const indexPath = await execGit(["rev-parse", "--git-path", "index"], { cwd: root, timeout: 5000 });
    const objects = path.resolve(root, String(objectsPath.stdout).trim());
    const index = indexPath.ok ? path.resolve(root, String(indexPath.stdout).trim()) : null;
    return { root, objects, index };
  }

  async function prepareRepo(rec) {
    const repo = await resolveRepo(rec.cwd);
    if (!repo) return null;
    const metaDir = path.join(rec.tempDir, "meta");
    const objects = path.join(metaDir, "objects");
    const index = path.join(metaDir, "index");
    try {
      await mkdir(objects, { recursive: true });
      if (repo.index) await copyFile(repo.index, index).catch(() => {});
    } catch {
      return null;
    }
    return {
      root: repo.root,
      objects,
      index,
      alternates: repo.objects,
    };
  }

  // 临时 index 以仓库 index 为种子，新对象写入临时目录，仓库对象库只读挂接。
  async function snapshot(rec) {
    if (!rec.repo) return null;
    const env = gitEnv(rec.repo);
    const added = await execGit(["add", "-A", "--ignore-errors"], {
      cwd: rec.repo.root,
      env,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_OUTPUT_LIMIT,
    });
    // 不可读文件会让 add 返回 1；接受该结果，后续 write-tree 仍可建立基线。
    if (!added.ok && added.code !== 1) return null;
    const tree = await execGit(["write-tree"], {
      cwd: rec.repo.root,
      env,
      timeout: GIT_TIMEOUT_MS,
    });
    if (!tree.ok) return null;
    return String(tree.stdout).trim() || null;
  }

  async function startRequest(sessionId, cwd) {
    const rec = {
      id: `wc-${Date.now().toString(36)}-${++counter}`,
      sessionId: typeof sessionId === "string" ? sessionId : "",
      cwd,
      tempDir: null,
      repo: null,
      baselineTree: null,
      endTree: null,
      captures: new Map(),
      captureChain: Promise.resolve(),
      entries: [],
      summary: null,
      finishPromise: null,
      status: "active",
      warning: "",
    };
    requests.set(rec.id, rec);
    if (rec.sessionId) bySession.set(rec.sessionId, rec.id);

    // 工作目录可能是符号链接；快照、捕获与显示统一使用真实路径。
    rec.cwd = await realpath(cwd).catch(() => cwd);
    try {
      rec.tempDir = await mkdtemp(path.join(tempRoot, TEMP_PREFIX));
    } catch (error) {
      rec.tempDir = null;
      rec.warning = error.message;
    }

    // 记录期间不阻塞发送：快照失败只放弃本轮 git 覆盖，文件工具捕获仍可用。
    rec.ready = (async () => {
      try {
        rec.repo = await prepareRepo(rec);
        rec.baselineTree = await snapshot(rec);
      } catch (error) {
        rec.warning = rec.warning || error.message;
      }
    })();

    prune();
    return { id: rec.id, ready: rec.ready };
  }

  function findRequest(sessionId, cwd) {
    if (sessionId && bySession.has(sessionId)) {
      const rec = requests.get(bySession.get(sessionId));
      if (rec && rec.status === "active") return rec;
    }
    // 扩展换绑或会话编号变化时，按工作目录回退；同时只允许一个活动请求。
    for (const rec of requests.values()) {
      if (rec.status === "active" && rec.cwd === cwd) return rec;
    }
    return null;
  }

  async function captureFile(rec, target) {
    if (!rec.tempDir) return;
    const record = { oldCopy: null, oldMissing: true, oversized: false, newCopy: null, newMissing: false };
    try {
      const info = await stat(target);
      if (!info.isFile()) return;
      if (info.size > maxFileBytes) {
        record.oversized = true;
      } else {
        const name = createHash("sha1").update(target).digest("hex");
        const copy = path.join(rec.tempDir, "captures", `${name}.old`);
        await mkdir(path.dirname(copy), { recursive: true });
        await copyFile(target, copy);
        record.oldCopy = copy;
        record.oldMissing = false;
      }
    } catch (error) {
      if (error.code !== "ENOENT") return;
    }
    rec.captures.set(target, record);
  }

  function capture({ sessionId, cwd, toolName, input } = {}) {
    if (disposed || !WRITE_TOOLS.has(toolName)) return Promise.resolve();
    const targetPath = input?.path;
    if (typeof cwd !== "string" || typeof targetPath !== "string" || targetPath.trim() === "") {
      return Promise.resolve();
    }
    if (targetPath.length > 4096) return Promise.resolve();
    const rec = findRequest(sessionId, cwd);
    if (!rec || !rec.tempDir) return Promise.resolve();
    const target = path.resolve(cwd, targetPath);
    if (rec.captures.has(target)) return rec.captureChain;

    // 先占位，避免同一文件在并发工具调用中被重复捕获。
    rec.captures.set(target, { pending: true });
    rec.captureChain = rec.captureChain.then(async () => {
      rec.captures.delete(target);
      await captureFile(rec, target);
    }).catch(() => {});
    return rec.captureChain;
  }

  async function finishCaptures(rec) {
    await rec.captureChain;
    const results = [];
    for (const [target, record] of rec.captures) {
      if (record.pending) continue;
      const copy = { ...record };
      try {
        const info = await stat(target);
        if (!info.isFile()) copy.newMissing = true;
        else if (info.size > maxFileBytes) copy.oversized = true;
        else {
          const name = createHash("sha1").update(target).digest("hex");
          const dest = path.join(rec.tempDir, "captures", `${name}.new`);
          await mkdir(path.dirname(dest), { recursive: true });
          await copyFile(target, dest);
          copy.newCopy = dest;
        }
      } catch (error) {
        if (error.code === "ENOENT") copy.newMissing = true;
      }
      results.push({ target, record: copy });
    }
    return results;
  }

  async function readSideFile(file) {
    if (!file) return null;
    const info = await stat(file);
    if (info.size > maxFileBytes) return { oversized: true };
    return { buffer: await readFile(file) };
  }

  async function buildCapturedEntry(rec, target, record) {
    const base = {
      path: target,
      display: displayPath(rec.cwd, target, rec.repo?.root),
      added: 0,
      deleted: 0,
      binary: false,
      oversized: false,
      source: { kind: "file", oldCopy: record.oldCopy, newCopy: record.newCopy },
    };
    if (record.oversized) return { ...base, oversized: true };
    const old = await readSideFile(record.oldCopy);
    const current = await readSideFile(record.newCopy);
    if (old === null && current === null) return null;
    if (old?.oversized || current?.oversized) return { ...base, oversized: true };

    const oldBuffer = old?.buffer ?? null;
    const newBuffer = current?.buffer ?? null;
    if (oldBuffer && newBuffer && oldBuffer.equals(newBuffer)) return null;
    const binary = (oldBuffer && isBinary(oldBuffer)) || (newBuffer && isBinary(newBuffer));
    if (binary) return { ...base, binary: true };
    const diff = createLineDiff(
      oldBuffer ? oldBuffer.toString("utf8") : "",
      newBuffer ? newBuffer.toString("utf8") : "",
      { maxLines: 8000, timeoutMs: 120 },
    );
    return { ...base, added: diff.added, deleted: diff.deleted };
  }

  async function buildGitEntries(rec) {
    if (!rec.repo || !rec.baselineTree || !rec.endTree) return [];
    const env = gitEnv(rec.repo);
    const result = await execGit([
      "diff-tree", "-r", "-M", "-z", "--numstat", rec.baselineTree, rec.endTree,
    ], { cwd: rec.repo.root, env, timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_OUTPUT_LIMIT });
    if (!result.ok) return [];
    const entries = [];
    for (const item of parseNumstat(result.stdout)) {
      const absolute = path.resolve(rec.repo.root, item.path);
      entries.push({
        path: absolute,
        display: displayPath(rec.cwd, absolute, rec.repo.root),
        added: item.added,
        deleted: item.deleted,
        binary: item.binary,
        oversized: false,
        source: {
          kind: "git",
          tree: rec.endTree,
          baseTree: rec.baselineTree,
          repoPath: item.path,
          oldRepoPath: item.oldPath ?? item.path,
        },
      });
    }
    return entries;
  }

  async function computeSummary(rec) {
    rec.endTree = await snapshot(rec).catch(() => null);
    const gitEntries = await buildGitEntries(rec).catch(() => []);
    const known = new Set(gitEntries.map((entry) => entry.path));
    const captured = rec.tempDir ? await finishCaptures(rec).catch(() => []) : [];
    const capturedEntries = [];
    for (const { target, record } of captured) {
      if (known.has(target)) continue;
      const entry = await buildCapturedEntry(rec, target, record).catch(() => null);
      if (entry) capturedEntries.push(entry);
    }

    const all = [...gitEntries, ...capturedEntries].sort((a, b) => a.display.localeCompare(b.display));
    const files = all.slice(0, maxFiles).map((entry, index) => ({ ...entry, index }));
    rec.entries = files;
    rec.summary = {
      requestId: rec.id,
      files: files.map(({ index, display, added, deleted, binary, oversized }) => ({
        index,
        display,
        added,
        deleted,
        binary,
        oversized,
      })),
      total: all.length,
      truncated: all.length > maxFiles,
    };
    rec.status = "finished";
    return rec.summary;
  }

  async function finish(requestId) {
    const rec = requests.get(requestId);
    if (!rec) return null;
    if (rec.finishPromise) return rec.finishPromise;
    rec.finishPromise = (async () => {
      try {
        await rec.ready;
        return await computeSummary(rec);
      } catch {
        rec.status = "finished";
        rec.summary = { requestId: rec.id, files: [], total: 0, truncated: false };
        return rec.summary;
      }
    })();
    return rec.finishPromise;
  }

  function summary(requestId) {
    const rec = requests.get(requestId);
    return rec?.summary ?? null;
  }

  async function readGitSide(rec, tree, repoPath) {
    if (!rec.repo || !tree || !repoPath) return null;
    const env = gitEnv(rec.repo);
    const size = await execGit(["cat-file", "-s", `${tree}:${repoPath}`], {
      cwd: rec.repo.root, env, timeout: 10000,
    });
    if (!size.ok) return null;
    if (Number(String(size.stdout).trim()) > maxFileBytes) return { oversized: true };
    const blob = await execGit(["cat-file", "blob", `${tree}:${repoPath}`], {
      cwd: rec.repo.root,
      env,
      timeout: 10000,
      encoding: "buffer",
      maxBuffer: maxFileBytes + 65536,
    });
    if (!blob.ok) return null;
    return { buffer: Buffer.isBuffer(blob.stdout) ? blob.stdout : Buffer.from(blob.stdout) };
  }

  async function diff(requestId, index) {
    const rec = requests.get(requestId);
    if (!rec) return null;
    if (!Number.isInteger(index) || index < 0) return null;
    const entry = rec.entries[index];
    if (!entry) return null;
    const base = {
      display: entry.display,
      added: entry.added,
      deleted: entry.deleted,
      binary: entry.binary,
      oversized: entry.oversized,
    };
    if (entry.binary) return { ...base, kind: "binary" };
    if (entry.oversized) return { ...base, kind: "oversized" };

    let oldSide;
    let newSide;
    try {
      if (entry.source.kind === "git") {
        oldSide = await readGitSide(rec, entry.source.baseTree, entry.source.oldRepoPath);
        newSide = await readGitSide(rec, entry.source.tree, entry.source.repoPath);
      } else {
        oldSide = await readSideFile(entry.source.oldCopy);
        newSide = await readSideFile(entry.source.newCopy);
      }
    } catch {
      return { ...base, kind: "missing" };
    }
    if (oldSide === null && newSide === null) return { ...base, kind: "missing" };
    if (oldSide?.oversized || newSide?.oversized) return { ...base, kind: "oversized" };

    const oldBuffer = oldSide?.buffer ?? null;
    const newBuffer = newSide?.buffer ?? null;
    if ((oldBuffer && isBinary(oldBuffer)) || (newBuffer && isBinary(newBuffer))) {
      return { ...base, kind: "binary" };
    }
    const result = createLineDiff(
      oldBuffer ? oldBuffer.toString("utf8") : "",
      newBuffer ? newBuffer.toString("utf8") : "",
    );
    return {
      ...base,
      kind: "text",
      hunks: result.hunks,
      added: result.added,
      deleted: result.deleted,
      coarse: result.coarse,
      truncated: result.truncated,
    };
  }

  function prune() {
    while (requests.size > maxRequests) {
      const oldest = requests.values().next().value;
      if (!oldest) break;
      requests.delete(oldest.id);
      if (bySession.get(oldest.sessionId) === oldest.id) bySession.delete(oldest.sessionId);
      if (oldest.tempDir) void rm(oldest.tempDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  function disposeSession(sessionId) {
    if (typeof sessionId !== "string" || sessionId === "") return;
    const id = bySession.get(sessionId);
    if (!id) return;
    const rec = requests.get(id);
    if (rec?.tempDir) void rm(rec.tempDir, { recursive: true, force: true }).catch(() => {});
    requests.delete(id);
    bySession.delete(sessionId);
  }

  function dispose() {
    disposed = true;
    for (const rec of requests.values()) {
      if (rec.tempDir) void rm(rec.tempDir, { recursive: true, force: true }).catch(() => {});
    }
    requests.clear();
    bySession.clear();
  }

  return {
    begin: startRequest,
    capture,
    finish,
    summary,
    diff,
    disposeSession,
    dispose,
  };
}

module.exports = {
  createWorkspaceChangesService,
  parseNumstat,
  displayPath,
  MAX_FILES,
  MAX_FILE_BYTES,
};
