// 逐行差异：Myers O(ND) 对齐，按上下文分块；超大或超时文件退化为整文件变化。
// 只服务改动审阅，不参与模型发送与文件写入。

const DEFAULT_CONTEXT = 3;
const DEFAULT_MAX_LINES = 8000;
const DEFAULT_MAX_EDIT_DISTANCE = 2000;
const DEFAULT_TIMEOUT_MS = 150;

// 行尾属于内容；这里只统一 CRLF，保留空行，末尾换行不额外生成空行。
function splitLines(text) {
  if (typeof text !== "string" || text === "") return [];
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

// 差异结果的行号从 1 开始；旧、新两侧分别计数。
function rowsOf(a, b, ops) {
  const rows = [];
  let oldBefore = 0;
  let newBefore = 0;
  for (const op of ops) {
    const kind = op.kind;
    rows.push({
      kind,
      oldBefore,
      newBefore,
      text: kind === "add" ? b[op.b] : a[op.a],
    });
    if (kind !== "add") oldBefore += 1;
    if (kind !== "remove") newBefore += 1;
  }
  return rows;
}

// Myers 最短编辑路径；trace 只保存每轮 [−d−1, d+1] 的窗口，避免按全文长度占用内存。
function shortestEdit(a, b, maxEditDistance, timeoutMs) {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const offset = max + 1;
  const size = 2 * max + 3;
  const v = new Int32Array(size).fill(-1);
  v[offset + 1] = 0;
  const trace = [];
  const deadline = Date.now() + timeoutMs;

  for (let d = 0; d <= max && d <= maxEditDistance; d += 1) {
    if (Date.now() > deadline) return null;
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const index = offset + k;
      let x;
      if (k === -d || (k !== d && v[index - 1] < v[index + 1])) {
        x = v[index + 1];
      } else {
        x = v[index - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[index] = x;
      if (x >= n && y >= m) return { trace };
    }
  }
  return null;
}

function backtrack(trace, a, b) {
  let x = a.length;
  let y = b.length;
  const ops = [];
  for (let d = trace.length - 1; d >= 1; d -= 1) {
    const v = trace[d];
    const base = d + 1;
    const at = (k) => v[base + k];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = at(prevK);
    const prevY = prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push({ kind: "equal", a: x - 1, b: y - 1 });
      x -= 1;
      y -= 1;
    }
    if (x === prevX) {
      ops.push({ kind: "add", b: y - 1 });
      y -= 1;
    } else {
      ops.push({ kind: "remove", a: x - 1 });
      x -= 1;
    }
  }
  // d=0 只包含公共前缀，没有编辑操作。
  while (x > 0 && y > 0) {
    ops.push({ kind: "equal", a: x - 1, b: y - 1 });
    x -= 1;
    y -= 1;
  }
  return ops.reverse();
}

// 只保留有变化的块；相隔不超过 2×上下文的块合并，避免碎成多段。
function hunksFromRows(rows, context) {
  const changed = [];
  for (const [index, row] of rows.entries()) {
    if (row.kind !== "equal") changed.push(index);
  }
  if (changed.length === 0) return [];

  const groups = [];
  let start = changed[0];
  let last = changed[0];
  for (const index of changed.slice(1)) {
    if (index - last - 1 <= context * 2) {
      last = index;
      continue;
    }
    groups.push([start, last]);
    start = index;
    last = index;
  }
  groups.push([start, last]);

  return groups.map(([first, end]) => {
    const from = Math.max(0, first - context);
    const to = Math.min(rows.length, end + context + 1);
    const slice = rows.slice(from, to);
    const oldCount = slice.filter((row) => row.kind !== "add").length;
    const newCount = slice.filter((row) => row.kind !== "remove").length;
    return {
      oldStart: oldCount === 0 ? 0 : rows[from].oldBefore + 1,
      oldCount,
      newStart: newCount === 0 ? 0 : rows[from].newBefore + 1,
      newCount,
      rows: slice.map((row) => ({
        kind: row.kind,
        oldLine: row.kind === "add" ? null : row.oldBefore + 1,
        newLine: row.kind === "remove" ? null : row.newBefore + 1,
        text: row.text,
      })),
    };
  });
}

function coarseResult(a, b) {
  return {
    hunks: [],
    added: b.length,
    deleted: a.length,
    coarse: true,
    truncated: false,
  };
}

/**
 * 计算逐行差异。
 * @param {string} oldText 旧内容（缺失时传空串）
 * @param {string} newText 新内容（缺失时传空串）
 * @param {{context?:number,maxLines?:number,maxEditDistance?:number,timeoutMs?:number}} [options]
 * @returns {{hunks:Array,added:number,deleted:number,coarse:boolean,truncated:boolean}}
 */
function createLineDiff(oldText, newText, options = {}) {
  const context = Number.isInteger(options.context) && options.context >= 0
    ? options.context
    : DEFAULT_CONTEXT;
  const maxLines = Number.isInteger(options.maxLines) && options.maxLines > 0
    ? options.maxLines
    : DEFAULT_MAX_LINES;
  const maxEditDistance = Number.isInteger(options.maxEditDistance) && options.maxEditDistance > 0
    ? options.maxEditDistance
    : DEFAULT_MAX_EDIT_DISTANCE;
  const timeoutMs = Number.isFinite(options.timeoutMs) && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;

  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0 && b.length === 0) {
    return { hunks: [], added: 0, deleted: 0, coarse: false, truncated: false };
  }
  if (a.length > maxLines || b.length > maxLines) return coarseResult(a, b);

  // 相同前缀与后缀不参与编辑距离，显著缩短常见的小改动。
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix += 1;
  }
  const aMiddle = a.slice(prefix, a.length - suffix);
  const bMiddle = b.slice(prefix, b.length - suffix);

  const search = shortestEdit(aMiddle, bMiddle, maxEditDistance, timeoutMs);
  if (search === null) return coarseResult(a, b);

  const ops = backtrack(search.trace, aMiddle, bMiddle);
  const rows = rowsOf(aMiddle, bMiddle, ops);

  // 还原前缀和后缀的公共行，让 hunk 行号与原文一致。
  const allRows = [
    ...a.slice(0, prefix).map((text) => ({ kind: "equal", oldBefore: 0, newBefore: 0, text })),
    ...rows,
    ...a.slice(a.length - suffix).map((text) => ({ kind: "equal", oldBefore: 0, newBefore: 0, text })),
  ];
  // 上面的 oldBefore/newBefore 只是占位；统一重算绝对行号。
  let oldBefore = 0;
  let newBefore = 0;
  for (const row of allRows) {
    row.oldBefore = oldBefore;
    row.newBefore = newBefore;
    if (row.kind !== "add") oldBefore += 1;
    if (row.kind !== "remove") newBefore += 1;
  }

  const added = ops.filter((op) => op.kind === "add").length;
  const deleted = ops.filter((op) => op.kind === "remove").length;
  return {
    hunks: hunksFromRows(allRows, context),
    added,
    deleted,
    coarse: false,
    truncated: false,
  };
}

module.exports = {
  createLineDiff,
  splitLines,
  DEFAULT_CONTEXT,
  DEFAULT_MAX_LINES,
  DEFAULT_TIMEOUT_MS,
};
