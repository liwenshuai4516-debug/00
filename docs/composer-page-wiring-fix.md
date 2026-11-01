# 页面接线收尾：恢复项目回调与修正HTML

已核对实际输入组件、页面发送与四个切换入口。专项测试现已位于tests/unit，实际语法检查及6个相关测试文件53项通过。实际页面模拟先通过11项，但在项目打开检查失败：创建projectPanel时漏传两个回调，点击后不能切换项目。本步骤先收尾此问题，再继续未确认发送手动处理接口。

继续由使用者亲手改应用代码；助手仅在临时副本验证下面两处修正。

最新结果：使用者已修正这两处，实际renderer语法检查与14项页面模拟检查通过；不再重复修复。HEAD加本轮页面功能块的隔离副本也通过组件53项和页面14项。下一步见 [未确认发送解除接口](composer-send-dismiss-step.md)。以下保留修复步骤与原失败记录供交接。

## 1. 恢复项目面板的两个参数

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/renderer.js`。

找到 `const projectPanel = createProjectPanel(`，从这一行至该调用的 `);`，整体替换为：

```js
const projectPanel = createProjectPanel(
  document.getElementById("project-panel"),
  window.agent,
  setBusy,
  openProject,
);
```

`setBusy`负责项目操作期间统一禁用页面操作；`openProject`负责真正打开项目，并等待输入绑定后再刷新各区域。保留后面的proposalPanel初始化，不修改project-panel组件。

当前组件仍要求这两个回调。漏传后点击会在进入业务try之前调用undefined，项目不会打开；添加项目也依赖setBusy。

## 2. 删除重复的body开始标签

文件：`/Users/liyingjun/Desktop/SW-QA/17-00/src/renderer/index.html`。

文件顶部目前是：

```html
<body>

  <body>
    <!-- 图标只用于展示，不承载业务行为。 -->
```

只删除第二个 `<body>`，保留第一个开始标签及文件末尾原有的 `</body>`。结果为：

```html
<body>

    <!-- 图标只用于展示，不承载业务行为。 -->
```

不需要重排整份HTML或改变图标缩进。这是源码结构修正，浏览器可能容忍重复标签，但源码仍应只有一对body。

## 3. 验证

在项目根目录执行：

```bash
node --check src/renderer/renderer.js
node --check src/renderer/components/composer-persistence.js
node --test tests/unit/composer-persistence.test.js tests/unit/composer-send-reconcile.test.js tests/unit/composer-draft-send-queue.test.js tests/unit/composer-draft-queue.test.js tests/unit/composer-draft-restore.test.js tests/unit/composer-drafts.test.js
rg -n '<body[ >]|</body>' src/renderer/index.html
```

预期53项通过；body搜索只找到一个开始标签和一个结束标签。再运行 `npm start`，检查：

1. 在当前已有消息的A对话输入未发送文字，点击另一个已登记项目，确认项目真正打开，页面消息、目录与模型跟随目标项目。
2. 返回原项目和原A对话，确认原输入保留；切换等待期间输入也应仍归原会话。
3. 取消添加项目，原对话与输入不变；项目操作结束后发送、停止和侧栏按钮恢复正确状态。

## 已完成的模拟验证与边界

临时副本：`/var/folders/zl/dv8m7cfs0mj0j3vf6psss9y80000gn/T/agent-composer-page-actual-9x7h05t4`。以HEAD为底，覆盖实际整个渲染层及实际IPC/preload，再只应用上面两处修正。实际页面失败前11项通过；修正后的候选通过全部14项Electron模拟检查，包括项目打开与输入隔离、发送/停止、异常恢复、状态重试、整页重建恢复及三档窗口布局。已查看候选截图。

检查仅使用临时存储、临时工作目录和模拟请求，未读取真实会话或配置、请求模型、写真实剪贴板。实际应用文件未由助手改写，也未记录用户对这两处修复的真实界面验收。

模型与配置是工作区同时存在的另一组改动，本轮未验证或提交其业务；保留原状。页面接线修复通过后，再做未确认发送记录的显式解除接口及页面确认，之后补空会话重建和关闭补保存；不提前称为完整重启恢复。
