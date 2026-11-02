# 主题设置

侧栏“设置”内并列提供“模型管理”和“主题”。主题页可选择默认深色或樱粉，立即改变应用内容区配色，关闭设置或返回模型管理均保留未保存的模型表单。主题不修改会话、模型配置、输入或文件草稿。

樱粉配色参考“主题移植资料-樱粉”的独立主题，将背景、表面、文字、边框、主要按钮、草稿增删语义色映射到本项目变量。聊天、侧栏、输入区、模型管理、菜单、工具结果、错误和关闭等待弹窗共用这些变量；Markdown 代码高亮单独按主题覆盖。关键词、函数名和注释颜色比资料中的原值更深，以适配粉色代码背景。

沿用 Electron 和原生 DOM，没有引入 React、服务端主题接口、主题目录扫描或壁纸。原生系统标题栏仍由操作系统管理。

## 目录与偏好

- `src/renderer/components/settings/settings-panel.js`：设置分类与统一忙碌状态；复用原模型管理面板。
- `src/renderer/components/theme/theme-settings.js`：主题选择、当前状态和保存失败提示。
- `src/renderer/theme/theme-preference.js`：仅接受 `dark`、`sakura`，使用当前 Electron 页面存储中的 `agent-client:theme` 保存选择；未知编号回到默认深色。
- `src/renderer/styles/themes/sakura.css`：仅在根节点 `data-theme="sakura"` 时生效的配色和代码高亮。
- `src/renderer/styles/settings.css`：设置分类和主题选择卡片布局。

主题样式作为本地文件静态加载；主题偏好模块在 head 中使用 `blocking="render"`，在首帧之前恢复选择。存储无法读取时使用默认深色；写入失败时仍可切换本页配色，并说明下次启动可能恢复此前选择。偏好使用 Electron 已有页面存储，不增加主进程、预加载或网络接口。

## 验证

```bash
node_modules/.bin/electron tests/ui/theme-settings.check.cjs
node_modules/.bin/electron tests/ui/model-management.check.cjs
node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
node_modules/.bin/electron tests/ui/window-close-page.check.cjs
```

主题专项使用临时 Electron 数据目录、模拟服务与真实渲染页面，检查切换、重建窗口恢复、未知偏好、存储读取和写入失败、分类键盘操作、忙碌保护、输入与未保存表单保留、语义表面色、实际文字/代码对比度，以及 1280/800/390 宽度截图。原模型管理、侧栏和关闭专项验证既有流程。本轮不读取用户真实配置或会话，不请求供应商模型；窗口重建检查不等同于用户真实退出再启动验收。

仅包含已提交基线与本次主题改动的副本已通过主题 23 项、模型管理 23 项、侧栏 35 项、关闭 14 项页面检查，以及 6 个相关脚本语法检查。已查看主题选择、聊天和模型管理的实际渲染截图。
