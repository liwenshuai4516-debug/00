# 会话置顶

2026-11-02：置顶服务、受限接口和侧栏页面已接通。使用者已授权助手直接实施后续代码，旧手写指南保留作历史参考。

## 使用

在已有历史对话右侧点击“对话操作”（三个点），展开后选择“置顶”或“取消置顶”。已置顶的对话显示文字标记，排在原目录组前面；多个置顶按置顶时间从新到旧排列，并列时按编号稳定排列。普通对话仍按消息活动排列，目录组的顺序和项目自动恢复目标不会因置顶改变。

“未发送”入口继续只负责找回输入，不提供置顶。操作当前或其他历史对话均不切换会话，不改聊天正文、输入、模型或待保存文件草稿。置顶状态持久化在原会话状态中，不写入Pi历史。

操作期间共用页面忙碌状态与主进程互斥入口，生成、整理、保存或切换时禁止置顶。输入自动保存继续使用共享存储队列，避免互相覆盖。窄窗口中置顶保留侧栏；历史对话确认打开成功后才收起侧栏，失败保留入口。

成功后恢复焦点到该行操作按钮。操作区支持Enter、Tab和Escape，中文组词时不处理Escape。保存失败或返回未确认时保留当前页面并提供“刷新对话列表”核对；保存确认后若列表刷新失败，明确提示“已保存”，刷新按钮只读取、不重复提交。

## 实现位置

- `src/main/services/session-service.js`：`setSessionPinned(sessionId, pinned)`；仅接受已存在且编号唯一、有目录归属的历史，明确布尔操作，重复置顶保留时间。`listSessions()`增加`pinnedAt`，仍按消息活动返回。
- `src/main/ipc/agent-ipc.js`与`src/preload/preload.js`：固定`agent:set-session-pinned`通道，复用`runIdleOperation`，仅转发编号与布尔值，不接受页面路径或时间。
- `src/renderer/components/session-list.js`及`styles/session-list.css`：独立操作按钮和行内展开区、置顶标记、目录组内排序、状态和刷新入口。所有标题使用纯文本。
- `src/renderer/renderer.js`与`components/page-shell.js`：置顶不重新绑定输入、不重建聊天；确认打开历史后发送`session-opened`通知外壳。页面离开时释放新增的文档监听器。

## 验证

实际工作区与只包含本次功能的精确提交副本均通过12个脚本语法检查、下列10文件69项单元检查：

```bash
node --test \
  tests/unit/session-pin.test.js \
  tests/unit/session-pin-ipc.test.js \
  tests/unit/session-list.test.js \
  tests/unit/session-state-store.test.js \
  tests/unit/session-state-list.test.js \
  tests/unit/composer-draft-service.test.js \
  tests/unit/session-service.test.js \
  tests/unit/project-open.test.js \
  tests/unit/agent-ipc.test.js \
  tests/unit/unsent-session-ipc.test.js
```

实际Electron的置顶19项、侧栏27项、未发送19项、关闭14项，共79项通过：

```bash
node_modules/.bin/electron tests/ui/session-pin-page.check.cjs
node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
node_modules/.bin/electron tests/ui/unsent-session-page.check.cjs
node_modules/.bin/electron tests/ui/window-close-page.check.cjs
```

新增专项贯通实际页面、preload、IPC、置顶服务和临时磁盘存储，覆盖当前/其他会话、保存等待、失败重试、保存后刷新失败、返回丢失后核对、多置顶与并列、搜索、生成/停止、重载恢复、真实键盘事件和1120/760/375宽度。原列表与关闭专项改用明确的打开按钮选择器，避免新增操作按钮干扰测试目标。

实际置顶报告/截图在系统临时目录`session-pin-ui-toNZuI`，精确副本报告在`session-pin-ui-lvl1Mm`；已查看375宽度截图。精确副本为`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-pin-exact-h4yqg9bj`，排除工作区原有视觉、格式和其他业务改动。

检查使用模拟聊天和临时会话/状态，不读取真实.env、配置或会话，不请求模型；历史字节不变、存储实例重建及页面重载恢复有自动覆盖。用户真实应用的置顶重启操作尚未单独反馈，自动检查不冒充用户验收。

## 下一步

可撤销归档现已接通，包含启动及项目恢复过滤、当前会话安全切换、归档视图、只读预览、撤销与恢复，详见 [会话归档](session-archiving.md)。下一步为上下文用量常驻入口。
