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

const markdown = new Marked({
  async: false,
  gfm: true,
  renderer: {
    // 回复中的原始 HTML 按文字展示。
    html({ text }) {
      return escapeHtml(text);
    },
    // 首步只展示链接文字和地址，不触发页面跳转。
    link({ tokens, href }) {
      return `${this.parser.parseInline(tokens)}（${escapeHtml(href)}）`;
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
    ],
    ALLOWED_ATTR: ["class", "start", "align"],
    ALLOW_DATA_ATTR: false,
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

  element.replaceChildren(fragment);
}
