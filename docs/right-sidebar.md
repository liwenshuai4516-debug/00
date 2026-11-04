# 右侧边栏

右侧边栏外壳参考 DeepSeek Harness 的 `ui-sidebar-right`，只实现停靠列、开合和宽度；**面板内容未实现**，页面把内容挂到 `#right-sidebar-body` 即可。

## 行为

- 会话 header 最右侧（对话操作 `...` 右侧）的镜像面板按钮只在收起时显示；点击打开。展开形状与左侧栏图标一致，方向镜像。
- 首次打开宽度取视口 45%，最小 300px，最大 70%，并给中栏保留 400px。示例：1120 窗口、左栏 296px 时右栏 424px、中栏 400px。
- 打开时若视口窄于 1024px，先**临时**收起左侧栏；不写回左栏的展开偏好，关闭右栏后左栏保持当前收起形态，重新启动应用恢复偏好。宽屏下左栏被拖得很宽、剩余空间不足 300px 时也会让位。
- 左缘 8px 热区可拖拽改宽；分隔条聚焦后支持 ←/→（Shift 加速）与 Home/End。宽度写入 `localStorage` 的 `agent-client:right-sidebar`，打开状态不持久化，刷新后回到收起态（与 DSH 的布局重置一致）。
- 视口窄于 768px 时打开为覆盖窗口的全屏面板；底层左侧栏与聊天设为 `inert`，关闭后恢复。窗口变宽后保持当前形态直到用户收起。
- 左栏重新展开导致中栏不足 400px 时，右栏自动收起让位。
- 中栏窄于 160px 时先隐藏 header 里的展开入口，避免挤压会话标题；中栏恢复后入口自动出现。
- 面板取页面底色与正文颜色，不做浮起卡片；左边框使用 `--border`，主题切换沿用项目语义变量。

## 结构与内容接入

```html
<aside id="app-right-sidebar" class="right-sidebar">
  <div class="right-sidebar__inner">
    <div class="right-sidebar__chrome">
      <div id="right-sidebar-tabs"></div> <!-- 预留 tab 条 -->
      <button id="right-sidebar-close">…</button>
    </div>
    <div id="right-sidebar-body"></div> <!-- 内容挂载点 -->
  </div>
  <div class="right-sidebar__resize"></div>
</aside>
```

顶栏 44px，只放收起按钮和预留的 `#right-sidebar-tabs`；内容区是 `#right-sidebar-body`，由页面自行填充和滚动。打开/收起按钮、宽度与主题都由外壳处理，业务代码不需要再接管几何。

## 验证

```bash
./node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
```

侧栏页面检查本轮 51 项，其中右侧栏覆盖：默认收起与 header 镜像按钮、45%/中栏 400 宽度约束、键盘改宽、宽度写入、收起恢复 0 宽与焦点、窄窗全屏及底层 `inert`、窄于 1024 时临时收起左栏。检查使用临时模拟接口，不读取真实配置或会话、不请求模型。

![右侧边栏打开](images/right-sidebar-open.png)

![右侧边栏收起时的 header 按钮](images/right-sidebar-closed.png)

## 边界

- 真实指针拖拽改宽未在自动检查中模拟，需真实鼠标操作验收。
- 面板内容、tab 条和真实业务交互尚未实现；本壳只保证空面板与开合几何。
- 全屏面板按 768px 断点自动选择，未提供手动全屏切换按钮；如需要可后续补。
