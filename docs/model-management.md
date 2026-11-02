# 模型与供应商管理

设置入口位于侧栏底部；历史对话可收起到“最近”，搜索时自动展开。设置只包含模型相关功能，沿用原生 DOM、Electron IPC 与现有深色样式，没有引入新框架。

模型管理布局按参考图调整为顶部工具栏、左侧供应商导航、右侧配置表单和模型参数卡片。自定义供应商按 ID 分组，点击供应商或模型卡片只选择编辑对象；保存、应用到当前对话和设置默认仍是独立操作。凭据、目录与参数补全收在对应折叠区；窄窗口将供应商列表改为横向滚动，表单保持独立滚动。页面背景、控件和边框全部使用现有主题变量。

## 使用与数据语义

- 内置目录读取 Pi 1.4 的供应商和模型；自定义接口支持 OpenAI Chat Completions、Responses、Anthropic Messages 和 Google Gemini。自定义模型的上下文窗口、输出上限、思考与图片能力可手工填写。
- 新增、编辑、复制、移除配置，以及切换当前对话模型、设置新对话默认、恢复原有默认。编辑生成新编号并保留旧快照；移除仅隐藏配置，已有对话仍按原编号恢复。编辑时密钥留空保留原密钥，页面从不回填已存密钥。
- 供应商可以保存多个命名密钥，选择激活项、删除。删除当前密钥后停止使用，不自动选择其他项。凭据来源“使用供应商激活密钥”的配置按请求读取激活项；单套配置独立保存的密钥不受该操作影响。
- OAuth 支持 SDK 提供的登录链接、设备码、文本/秘密/选项/手工授权码提示、回复、取消和退出。关闭设置不取消登录，重开恢复当前流程；退出应用取消未完成流程。不同配置共用同一供应商的 OAuth 凭据和 SDK 刷新锁，不复制临时访问令牌。
- 获取/测试模型列表与刷新已保存配置的目录支持原地址留空密钥探测、404 回退和超时。改变地址后必须显式输入密钥才能探测。测试成功仅表示模型列表可读，不证明推理、权限或额度可用。
- 官方目录通过 SDK 显式刷新；手工补充内置模型保存在本地目录中。刷新合并保留已有参数，不覆盖已保存配置快照。
- 参数补全读取 OpenRouter 和 models.dev 公开目录，显示来源、匹配编号、歧义和进度，可取消。可填写明确的参考目录编号；只向当前模型表单的空白字段补充，手工修改的能力选项不会被覆盖。未知参数不填零，不自动保存或切换模型。
- 思考强度限定当前模型支持的档位，写入当前会话，不更改全局默认。

旧的 V1/V2 `model-settings.json` 继续读取；首次成功修改时才升级旧记录。原有 SDK 凭据可继续使用。没有隐式导入来源项目的明文配置、覆盖 `.env` 或移动历史会话。

## 代码归类

- `src/main/storage/model-settings-store.js`：配置快照、默认项、隐藏状态、目录元信息。
- `src/main/storage/model-catalog-store.js`：独立保存 SDK 官方目录快照，重启恢复，不读取个人 `models.json`。
- `src/main/storage/model-credentials-store.js`：命名密钥与 OAuth 凭据，系统加密、串行写入和原子发布。文件位于 `userData/model-credentials.json`，不向页面返回明文或密文。
- `src/main/model/`：目录探测、参数补全、OAuth 流程与运行时凭据适配。
- `src/main/services/model-settings-service.js`：模型管理业务组装。
- `src/main/ipc/model-ipc.js`：固定接口白名单、共用操作互斥、按窗口管理事件订阅；由现有 `agent-ipc.js` 注册。
- `src/renderer/components/model/`：供应商导航、凭据、目录、补全局部交互；现有 `model-settings-panel.js` 负责组装。样式仍在 `src/renderer/styles/model-settings.css`。

## 验证

针对性单元/真实 SDK 初始化检查：

```bash
node --test tests/unit/model-settings.test.js tests/unit/model-profiles.test.js \
  tests/unit/model-settings-env.test.js tests/unit/model-catalog-fetch.test.js \
  tests/unit/model-catalog-store.test.js \
  tests/unit/model-credentials.test.js tests/unit/model-runtime-credentials.test.js \
  tests/unit/model-oauth.test.js tests/unit/model-enrichment.test.js \
  tests/unit/model-ipc.test.js tests/unit/model-thinking.test.js \
  tests/unit/model-switch.test.js tests/unit/model-list.test.js \
  tests/unit/model-restore.test.js tests/unit/pi-agent-init.test.js \
  tests/unit/session-info.test.js tests/unit/agent-ipc.test.js
```

实际 Electron 页面、预加载和 IPC 接线：

```bash
./node_modules/.bin/electron tests/ui/model-management.check.cjs
./node_modules/.bin/electron tests/ui/sidebar-layout.check.cjs
./node_modules/.bin/electron tests/ui/window-close-page.check.cjs
```

页面专项使用临时配置、系统加密和模拟服务商，验证编辑、复制、默认、密钥增删激活、授权提示/重开/回复/取消/退出、参数补全、目录刷新、思考强度、聊天输入保留及宽窄布局。真实 SDK 专项验证动态密钥、恢复和并发 OAuth 刷新，供应商刷新实现由本地替身提供。测试不读取个人 `.env`、SDK 配置或真实会话，不请求付费模型；真实供应商登录和推理不在本轮自动验收结论内。

2026-11-02 收尾：仅含 HEAD 与本次功能的精确副本通过 59 项单元/SDK 检查、模型管理 13 项、侧栏 35 项、正常关闭 14 项页面检查及 36 个脚本语法检查。已查看 1280/390 宽度设置截图。原工作区无关的格式、视觉和业务改动保留，未计入该提交的验收结论。

2026-11-02 布局更新：实际工作区与仅含最新提交及本次布局改动的副本均通过模型管理 23 项、侧栏 35 项、正常关闭 14 项页面检查；4 个修改脚本语法检查通过。额外核对供应商与模型卡片选择不隐式保存或切换会话、顶部目录刷新保留模型选择、主题背景变量，以及 1280/800/390 宽度布局截图。本轮只调整渲染层布局与对应导航接线，没有新增后台接口或框架。
