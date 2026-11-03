// 行尾属于行内容：不能 trim，也不能把 CRLF 统一成 LF。
function splitLines(text) {
  return text.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g).filter(Boolean);
}

export function buildLineDiff(oldText, newText) {
  const before = splitLines(oldText);
  const after = splitLines(newText);

  // 使用最长公共子序列对齐完整行，保留原始上下文和换行。
  const lengths = Array.from(
    { length: before.length + 1 },
    () => new Uint16Array(after.length + 1),
  );

  for (let i = before.length - 1; i >= 0; i -= 1) {
    for (let j = after.length - 1; j >= 0; j -= 1) {
      lengths[i][j] =
        before[i] === after[j]
          ? lengths[i + 1][j + 1] + 1
          : Math.max(lengths[i + 1][j], lengths[i][j + 1]);
    }
  }

  const rows = [];
  let i = 0;
  let j = 0;

  while (i < before.length || j < after.length) {
    if (i < before.length && j < after.length && before[i] === after[j]) {
      rows.push({
        kind: "equal",
        oldLine: i + 1,
        newLine: j + 1,
        text: before[i],
      });
      i += 1;
      j += 1;
    } else if (
      i < before.length &&
      (j === after.length || lengths[i + 1][j] >= lengths[i][j + 1])
    ) {
      rows.push({
        kind: "remove",
        oldLine: i + 1,
        newLine: null,
        text: before[i],
      });
      i += 1;
    } else {
      rows.push({
        kind: "add",
        oldLine: null,
        newLine: j + 1,
        text: after[j],
      });
      j += 1;
    }
  }

  return rows;
}

export function renderProposalDiff(review) {
  const { startLine, oldText, newText } = review;

  const region = document.createElement("div");
  region.className = "proposal-diff-scroll";
  region.tabIndex = 0;
  region.setAttribute("role", "region");
  region.setAttribute("aria-label", "文件逐行差异，可横向滚动");

  const table = document.createElement("table");
  table.className = "proposal-diff";

  const caption = document.createElement("caption");
  caption.textContent = `从文件第 ${startLine} 行开始。旧行对应原文件，新行对应保存后的预计文件。`;

  const head = document.createElement("thead");
  const headings = document.createElement("tr");

  for (const label of ["旧行", "新行", "变化", "内容", "行尾"]) {
    const cell = document.createElement("th");
    cell.scope = "col";
    cell.textContent = label;
    headings.appendChild(cell);
  }

  head.appendChild(headings);
  const body = document.createElement("tbody");

  for (const row of buildLineDiff(oldText, newText)) {
    const tr = document.createElement("tr");
    tr.dataset.kind = row.kind;

    const change = {
      equal: ["=", "不变"],
      remove: ["−", "删除"],
      add: ["+", "新增"],
    }[row.kind];

    // 算法返回片段内行号；旧、新两侧分别换算，增删行的空号保持为空。
    const oldLine = row.oldLine === null ? null : row.oldLine + startLine - 1;
    const newLine = row.newLine === null ? null : row.newLine + startLine - 1;

    for (const value of [oldLine, newLine, change[0]]) {
      const cell = document.createElement("td");
      cell.textContent = value ?? "";
      tr.appendChild(cell);
    }

    tr.children[2].setAttribute("aria-label", change[1]);

    const content = document.createElement("td");
    const code = document.createElement("code");
    const ending = row.text.match(/\r\n$|[\r\n]$/)?.[0] ?? "";

    // 正文保留原始字符，空白标记通过 CSS 叠加显示。
    const text = ending ? row.text.slice(0, -ending.length) : row.text;

    for (const part of text.match(/[ \t]|[^ \t]+/g) ?? []) {
      if (part === " " || part === "\t") {
        const space = document.createElement("span");
        space.className = "diff-whitespace";
        space.dataset.marker = part === " " ? "·" : "→";
        space.textContent = part;
        code.appendChild(space);
      } else {
        code.appendChild(document.createTextNode(part));
      }
    }

    content.appendChild(code);

    const end = document.createElement("td");
    end.textContent = {
      "\n": "LF ↵",
      "\r\n": "CRLF ↵",
      "\r": "CR ↵",
      "": "无换行",
    }[ending];

    tr.append(content, end);
    body.appendChild(tr);
  }

  table.append(caption, head, body);
  region.appendChild(table);
  return region;
}
