# 会话归档与恢复

2026-11-02：已有历史对话的归档、恢复、撤销和自动恢复过滤已接通。下一步为上下文用量常驻入口。

## 使用

1. 在对话右侧点击三个点，选择“归档”。普通列表隐藏该对话，并显示约8秒的“撤销”提示；指针停留、键盘聚焦或操作忙碌时暂停计时。
2. 点击列表顶部“已归档”可按目录浏览或搜索。点击标题只读预览历史，不切换当前对话。
3. 在已归档行的操作菜单中选择“恢复对话”。恢复和撤销均保留当前对话与新输入；切回“对话”后手动打开原会话，才恢复其输入和文件草稿。

提示消失、页面重载或应用重启后，仍可从“已归档”恢复。原编号、历史、模型、工作目录、置顶、输入及待确认发送快照保持原意；不删除或移动历史文件。“未发送”入口继续负责找回空会话输入，本版不提供空会话归档。

归档当前会话前先保存输入，准备同目录新空会话，归档落盘成功后才切换。准备或写入失败保留原会话，提供重试。生成、整理、文件保存和切换期间禁止归档或恢复；窄窗口操作后保留侧栏。

启动及项目打开会跳过归档项，再检查目录和应用绑定；全部归档时新建。重复打开当前项目仍保留当前对话。归档与恢复不改变消息活动排序。

## 失败处理

- 输入保存失败：不进入归档，原输入保留。
- 归档已确认但列表刷新失败：显示已保存，使用“刷新对话列表”只读核对。
- 返回丢失：先核对实际当前编号，避免将原输入当作新会话输入。若核对也失败，保持编辑、发送及切换冻结，点击列表刷新再次核对，不重复提交归档。
- 应用状态损坏：自动恢复明确报错，不将归档项当作普通历史重新打开，不覆盖原状态。

## 实现位置

- `src/main/services/session-service.js`：归档/恢复事务、列表元数据、拒绝直接打开归档项。
- `bootstrap.js`、`pi-agent.mjs`、`workspace/workspace-session.mjs`：传递归档编号，过滤启动及项目恢复候选。
- `src/main/ipc/agent-ipc.js`、`src/preload/preload.js`：固定通道，仅接受编号和布尔状态，共用操作互斥。
- `src/renderer/components/session-list.js`、`archive-notice.js`、`history-preview.js`：分视图、撤销计时及纯文本预览。
- `src/renderer/renderer.js`：保存输入、安全切换、异常核对及恢复操作；局部样式位于`styles/session-list.css`。

## 验证

实际工作区与精确提交副本均通过17个脚本语法及下列16文件103项单元检查：

```bash
node --test \
  tests/unit/session-archive.test.js \
  tests/unit/archive-notice.test.js \
  tests/unit/session-pin.test.js \
  tests/unit/session-pin-ipc.test.js \
  tests/unit/session-list.test.js \
  tests/unit/session-state-store.test.js \
  tests/unit/session-state-list.test.js \
  tests/unit/session-service.test.js \
  tests/unit/session-workspace.test.js \
  tests/unit/workspace-session.test.js \
  tests/unit/workspace-resume.test.js \
  tests/unit/unsent-session-service.test.js \
  tests/unit/unsent-session-ipc.test.js \
  tests/unit/agent-ipc.test.js \
  tests/unit/project-open.test.js \
  tests/unit/window-close-bootstrap.test.js
```

页面检查使用实际页面、preload、IPC、归档服务和临时磁盘。归档16项、置顶19项、未发送19项、关闭14项均通过；侧栏实际34项、精确副本27项通过，实际多出的设置检查属于其他工作区功能，不纳入本次提交。

```bash
node_modules/.bin/electron tests/ui/session-archive-page.check.cjs
node_modules/.bin/electron tests/ui/session-pin-page.check.cjs
node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
node_modules/.bin/electron tests/ui/unsent-session-page.check.cjs
node_modules/.bin/electron tests/ui/window-close-page.check.cjs
```

专项覆盖归档/恢复保留输入、模型、快照、置顶和历史，当前会话准备/历史/写入失败释放候选，启动/项目恢复过滤、全部归档及状态损坏，撤销倒计时暂停与释放，页面返回丢失、核对失败冻结、刷新恢复，以及1120/760/375宽度。已查看375宽度截图，并检查列表本身无横向溢出。

默认及实际启动工厂另通过真实Pi初始化检查，禁用网络、使用临时配置和占位凭据。SDK打开未归档会话时可能正常追加初始化记录，专项要求被跳过的归档历史字节不变；模拟Agent的归档/恢复专项检查全部历史字节不变。

所有检查不读取真实.env、配置、会话或本地验收文件，不请求模型。自动验证不能代替用户真实归档重启验收；当前尚无该项用户反馈。可用已有历史手动验证归档其他会话、归档当前会话后输入新内容再撤销，以及重启后从归档列表恢复，无须额外请求模型。
