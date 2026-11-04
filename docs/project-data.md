# 项目前置数据（第一期）

沿用现有项目菜单的登记与名称，每个项目增加地址、账号、密码三个字段。本期没有新增页面、编辑 IPC、模型工具或自动登录；主进程通过 `projectService.getProjectData(projectId)` 按需读取四项数据。

## 配置文件

配置位于 Electron `app.getPath("userData")` 下的 `projects.json`，与已有项目登记共用文件。macOS 开发模式通常是：

```text
~/Library/Application Support/lws/projects.json
```

以启动入口实际使用的 `app.getPath("userData")` 为准，应用名称或用户数据目录被调整时路径也会改变。这不是源码目录下的配置，也不在被测工作区的 `qa/data/` 内。

先在现有项目菜单添加工作目录，应用会生成项目记录，并为新项目预留三个空字段。编辑前完全退出客户端，避免手工保存与应用的添加、重命名操作相互覆盖。使用普通文本编辑器修改目标记录；不要修改已有的 `id` 和 `workspaceDir`，不要将整份文件替换成下方示例。

```json
{
  "projects": [
    {
      "id": "保留已有项目编号",
      "name": "订单系统",
      "workspaceDir": "/保留已有真实工作目录",
      "address": "https://example.invalid",
      "account": "",
      "password": ""
    }
  ]
}
```

- `name`：复用项目登记名称；修改后重启会影响现有项目菜单显示，不重命名磁盘目录。与界面重命名约定一致，建议使用 1～40 个字符。
- `address`：被测系统的 HTTP/HTTPS 地址，不是工作目录路径；不能在 URL 中嵌入账号密码。空字符串表示尚未配置。
- `account`、`password`：字符串，默认空。保留原文，包括首尾空格；使用 JSON 的标准转义表示双引号、反斜杠等字符。

旧项目可以手工补充字段；缺失字段读取为空字符串，不自动迁移或重写旧记录。显式 `null`、数字等不视为空值，读取前置数据时报错。配置不完整不影响普通项目打开；是否满足具体测试的登录要求由使用方判断。

## 读取与保密边界

`src/main/storage/project-store.js` 的 `readData(projectId)` 和现有主进程项目服务的 `getProjectData(projectId)` 返回：

```json
{
  "name": "订单系统",
  "address": "https://example.invalid",
  "account": "",
  "password": ""
}
```

每次读取从磁盘加载，不缓存密码；只接受已登记编号，不接受任意文件路径，不打开会话、不访问目标地址，也不把读取成功称为身份验证通过。未登记编号、非法字段或地址、损坏 JSON 明确报错；错误不带原始 JSON 及字段值，不自动清空配置。

现有列表、添加和重命名只向页面返回 `id`、`name`、`workspaceDir`。后台保存时保留其他记录及其扩展字段；JSON 格式错误时不覆盖原文件。名称等登记信息的原有校验继续适用。

为支持本期手工编辑，账号密码是**本机明文配置，不是加密凭据库**。应用写入时使用 `0600` 文件权限和同目录临时文件原子替换；手工编辑器或同步、备份软件可能改变权限或复制文件，不能据此承诺加密或进程访问隔离。不要将实际文件复制进源码、报告或聊天，不要记录、导出或向模型返回 `getProjectData()` 的完整结果。后续增加自动执行时应在主进程内按需使用凭据，不能直接把本接口登记为返回密码的模型工具。

本期沿用已有临时登录态机制，没有持久登录态复用、多环境、凭据加密或团队共享。`qa-workspace-prepare` 的职责仍是准备测试输入目录，不会读取或复制这份配置。

## 验证

```bash
node --test tests/unit/project-data.test.js tests/unit/project-store.test.js \
  tests/unit/project-service.test.js tests/unit/project-rename.test.js \
  tests/unit/project-rename-ipc.test.js tests/unit/project-open.test.js
```

本期使用临时目录、模拟账号密码和现有真实存储/服务/IPC 检查：新记录默认值与文件权限、旧记录兼容、按编号隔离及重读、原文保留、配置持久化、页面返回字段白名单，以及损坏配置的报错与保护。未读取真实配置或会话，不访问业务站点，不请求模型；不替代真实登录或测试执行验收。
