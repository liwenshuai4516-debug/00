import { Marked } from "../../../node_modules/marked/lib/marked.esm.js";
import DOMPurify from "../../../node_modules/dompurify/dist/purify.es.mjs";
import hljs from "../../../node_modules/@highlightjs/cdn-assets/es/highlight.min.js";

function escapeHtml(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

// 只把工作目录内的本地路径做成预览入口；外部地址和页面锚点仍按文字展示。
function localPreviewPath(href) {
  if (typeof href !== "string") return null;
  const value = href.trim();
  if (value === "" || value.startsWith("#") || value.startsWith("//")) return null;
  // 允许 Windows 盘符（C:\\path）；其他协议一律视为外部地址。
  if (/^[a-z][a-z0-9+.-]*:/i.test(value) && !/^[a-z]:[\\/]/i.test(value)) return null;
  const path = value.split(/[?#]/)[0];
  return path === "" ? null : path;
}

const markdown = new Marked({
  async: false,
  gfm: true,
  renderer: {
    // 回复中的原始 HTML 按文字展示。
    html({ text }) {
      return escapeHtml(text);
    },
    // 本地路径生成本地预览入口；外部链接只展示文字和地址，不触发跳转。
    link({ tokens, href }) {
      const text = this.parser.parseInline(tokens);
      const path = localPreviewPath(href);
      if (path) return `<a href="#" data-file-path="${escapeHtml(path)}">${text}</a>`;
      return `${text}（${escapeHtml(href)}）`;
    },
    // 图片说明按文字展示，不自动请求外部图片。
    image({ text }) {
      return `图片：${escapeHtml(text)}`;
    },
  },
});

export function renderMarkdown(element, text) {
  // 只允许正文排版所需的标签和属性。
  const fragment = DOMPurify.sanitize(markdown.parse(text), {
    RETURN_DOM_FRAGMENT: true,
    ALLOWED_TAGS: [
      "p", "br", "strong", "em", "del", "blockquote",
      "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6",
      "pre", "code", "hr", "table", "thead", "tbody", "tr", "th", "td",
      "a",
    ],
    ALLOWED_ATTR: ["class", "start", "align", "href", "data-file-path"],
    // 只有本模块生成的链接带 data 属性；Markdown 中的原始 HTML 已按文字转义。
    ALLOW_DATA_ATTR: true,
    ALLOW_ARIA_ATTR: false,
  });

  for (const code of fragment.querySelectorAll("pre > code")) {
    const language = code.className.match(/(?:^|\s)language-(\S+)/)?.[1];
    code.classList.add("hljs");

    // 只高亮已声明且受支持的语言；其他代码保留原文。
    if (language && hljs.getLanguage(language)) {
      code.innerHTML = hljs.highlight(code.textContent, {
        language,
        ignoreIllegals: true,
      }).value;
    }
  }

  decorateCodeBlocks(fragment);
  element.replaceChildren(fragment);
}

// 代码块增加语言标签和复制按钮；按钮只读取已清理的纯文本，不参与 Markdown 解析。
function decorateCodeBlocks(fragment) {
  for (const pre of fragment.querySelectorAll("pre")) {
    const code = pre.querySelector("code");
    if (!code) continue;

    const language = code.className.match(/(?:^|\s)language-(\S+)/)?.[1] ?? "";
    const figure = document.createElement("figure");
    figure.className = "code-block";

    const header = document.createElement("figcaption");
    header.className = "code-block-header";

    const label = document.createElement("span");
    label.className = "code-block-language";
    label.textContent = language || "text";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "code-block-copy";
    copy.textContent = "复制";
    copy.setAttribute("aria-label", "复制这段代码");
    copy.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(code.textContent);
        copy.textContent = "已复制";
      } catch {
        copy.textContent = "复制失败";
      }
      // 提示短暂保留后恢复，不改变代码块内容。
      setTimeout(() => {
        copy.textContent = "复制";
      }, 1200);
    });

    header.append(label, copy);
    // 先用 figure 占住 pre 的位置，再把 pre 移入，避免把节点替换进它自己。
    pre.replaceWith(figure);
    figure.append(header, pre);
  }
}
