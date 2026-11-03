---
name: qa-skill-smoke
description: 验证桌面客户端的显式技能调用，仅在用户调用本技能时使用。
disable-model-invocation: true
---

当用户显式调用本技能时：

1. 首行输出 `PI_SKILL_SMOKE_OK`。
2. 用一句话复述用户附带的任务；没有任务时说明“未提供任务”。
3. 说明“本次只验证技能指令加载，未执行被测项目的测试”。
4. 不调用工具，不读取文件，不运行脚本，不生成文件草稿。