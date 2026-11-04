# 会话内容搜索

侧栏搜索框在标题过滤之外，额外搜索最近会话的**展示文本**；命中后在该会话行下方显示片段。

## 行为

- 输入即时按标题过滤；内容搜索防抖 250ms，少于 2 个字符不扫描。
- 每次最多扫描最近 8 个会话、返回 12 个命中会话；每个会话展示第一处命中的片段，单会话计数最多 99 次。
- 标题没命中但内容命中的会话也会出现在列表里，并展开所属分组；片段以 `…` 标出截断。
- 新关键词会立即清掉旧片段，迟到的搜索响应按请求序号丢弃；内容搜索失败不影响按标题过滤。
- 只搜索展示文本（与导出范围一致），不搜索工具内部字段或未展示的思考内容。

## 实现

- `src/main/services/session-search-service.js`：注入 `listSessions` 与 `previewSession`，限制扫描量、结果数与搜索词长度，返回 `{ id, matches, snippet }`。
- `src/main/ipc/agent-ipc.js`：`agent:search-sessions` 只接收关键词，读取范围由主进程会话服务决定。
- `src/renderer/renderer.js`：防抖、请求序号与结果映射；`src/renderer/components/session-list.js`：命中会话纳入过滤并在行下展示片段。

## 验证

- `tests/unit/session-search-service.test.js`：片段与计数、读取失败跳过、少字符不扫描、扫描/结果上限、长文本省略号、超长搜索词拒绝。
- `tests/ui/sidebar-layout.check.cjs`：标题不命中时通过内容命中展示片段，随后换关键词片段被清掉。
