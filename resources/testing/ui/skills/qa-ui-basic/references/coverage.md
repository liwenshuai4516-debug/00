# 本轮清单与候选转换统计

本规程只维护本轮功能记录和统计，不替代用例设计、探索约定、独立验证或发布。使用实际登记的 `qa_ui_coverage`，不通过手工填百分比或扫描所有历史任务推断本轮范围。旧回归没有本轮清单时，报告转换情况为“无法计算”，仍可正常交付原执行结果。

## 产物与调用

在当前真实工作区使用原生文件工具维护 `qa/ui/rounds/<roundId>/draft.json`，roundId 是本轮唯一编号，不使用 runId 代替。主 Agent 在任何探索、生成前保存首版范围；同一轮后续更新沿用编号。已存在编号先读准确版本，不覆盖或新建等价轮次绕过错误。

```json
{
  "schema": "qa-ui-round/v1",
  "roundId": "round-contract-query",
  "baseRevision": null,
  "projectId": "pms",
  "mode": "candidate",
  "goal": "为指定合同查询功能生成候选，并继续只读自由探索",
  "budget": "最多 8 个探索任务，包含发现核对与留档时间",
  "status": "active",
  "stopReason": "",
  "taskIds": [],
  "features": [
    {
      "featureId": "contract-number-search",
      "modulePath": ["合同管理", "经营合同"],
      "name": "按合同编号查询",
      "role": "项目成员",
      "initialState": "列表存在有来源的目标记录",
      "branch": "查询命中",
      "confirmation": "pending",
      "exploration": "pending",
      "inScope": true,
      "scopeReason": "用户明确指定的生成范围，来源：requirements/query.md",
      "sources": [{ "path": "requirements/query.md" }],
      "checks": [
        {
          "checkId": "number-hit",
          "goal": "输入目标编号后只显示目标记录",
          "reason": "等待探索及候选生成"
        }
      ]
    }
  ]
}
```

示例中的需求路径、角色、初态和规则须替换为实际存在的来源，不照抄虚构文件。缺少会改变目标的信息按主流程澄清；没有已知功能时允许从空 features 开始。featureId 在本轮稳定，checkId 在整轮唯一；独立角色、初态、分支按用例设计规则区分，不为每个字段机械扩展全局编号。

调用 `qa_ui_coverage({roundId, action:"save"})`。工具检查并返回四位 revision、counts、summaryFile、summaryDocument。首次 baseRevision 为 null，后续必须填写上次实际保存成功的 revision。每次保存产生 `qa/ui/rounds/<roundId>/<revision>/summary.json` 与 `summary.md`，不覆写旧版本；JSON 含完整 manifest、映射、准确文件哈希和统计。Markdown 是概览和逐项明细，不与执行批次 summary 混用。

`qa_ui_coverage({roundId, action:"read", revision:"0002"})` 读取准确历史快照；省略 revision 返回该轮最新已保存版本。交付须引用准确版本，不用其他轮次或目录中任意最新文件替代。读取不依赖 draft 或后续资产仍存在，不重新计算历史统计。

## 持续登记与映射

1. 每次工具任务完成后，将真实 taskId 追加到 taskIds。按探索规则保留本轮全部优先功能、自由发现、未覆盖和待确认项；检查缺口不能因缺数据、身份、规则或自动化能力而删去。任务级 discoveries.md 与长期索引仍按原规则维护，本轮清单不替代它们。
2. sources 使用相对工作区的实际文件路径；探索证据填写 `{taskId, path:"qa/ui/tasks/<taskId>/actions.jsonl"}` 或该任务截图。工具只核对文件存在、归属及来源任务终值；主 Agent 仍须读取成功动作、done 与截图判断事实，不能把失败步骤或仅有名称的入口当确认。确认功能须至少有一个 completed 且 cleanupConfirmed 的本轮来源。失败、取消和清理未知的部分观察只能标 pending，不进入长期确认索引。
3. confirmation 为 confirmed/pending；exploration 为 identified/explored/blocked/pending。功能存在已确认但业务规则、数据或身份缺失时，保留 confirmed，检查项 reason 写清缺口，不通过降级确认状态移出分母。初始需求尚未核实或页面缺失时保留 pending 并单列。
4. 自由发现默认 inScope=false，scopeReason 写明仅探索；不能自动扩大候选或写授权。mode=explore 全部 inScope=false，生成率不适用。确有当前用户范围依据需要补入设计时，可由 false 改 true，记录理由并保存新版本。已经纳入的功能不能移出分母，功能与已登记检查目标不能删除或改写；纠错或范围改变须说明原记录与新目标，不静默覆盖历史。
5. `qa_ui_save_candidate` 实际成功后，在对应检查项增加 `case:{caseId,revision}`、`expectedIds:["实际预期编号"]`，再保存清单。工具核对已登记 revision、哈希、项目、角色、成功来源任务和业务断言引用；计划 caseId、draft、手动占位用例不计数。每个独立检查项最多关联一个准确候选，一个 case 只能对应一个独立检查项；更新补丁时替换该项 revision，不能复制修订凑覆盖。必要导航、准备与清理不作为额外功能关联。
6. 无候选的检查项必须有 reason，可写“已设计，缺数据/能力受阻”“生成失败”等。关联的候选已保存但验证失败仍属于已生成；验证引用存在而 summary 尚缺时标 unknown，不推断通过。已有验证摘要须与准确版本及来源任务一致。验证/发布状态是保存时的快照，后续结果须显式保存新版本才纳入本轮报告。

本轮新生成以原探索任务已登记且 startedAt 不早于首版清单保存时间判定；修复任务使用 baseTaskId 追溯原探索，不把历史修复当新功能。其余有效候选标 reused，单列历史复用。开始前先保存首版十分必要；既有任务不能通过事后补清单冒充本轮新生成。

## 统计口径

- 主指标：功能点用例转换率 = 范围内已确认且本轮至少生成一条有效候选的功能数 / 范围内已确认功能数 × 100%。多条 case 覆盖同一功能只计一个功能；修订和重复运行不增加 case 数。
- 同时展示全部登记、已确认、待确认、范围内待确认、未纳入生成范围、本轮生成 case 与历史复用数。缺数据、身份或能力的范围内已确认功能仍在分母；缺预期只标检查项受阻，不降级已确认事实。
- 范围内检查项总数、已有候选数与缺项数另列，包含待确认功能的检查项。某功能已有一例不等于其全部分支完成；只看主指标会掩盖缺口，必须同时交付完整明细。
- 分母为零或纯探索返回 conversionRate=null，展示“不适用”；缺清单、版本或损坏映射停止计算，展示“无法计算”与错误，不能读旧版数字冒充当前结果。
- 文件、编号、预期引用与数量校验不证明业务语义覆盖；仍按 qa-ui-case-design 检查目标与断言是否相符。生成率、独立验证结果和正式回归通过率分开呈现。

## 收尾与异常

队列正常处理完成时 status=completed；预算耗尽、用户停止、取消或异常时 status=partial，并填写 stopReason、保留未完成队列对应功能和缺口。这里 completed 只表示本轮清单收尾，不表示所有 case 通过，也不代表全站覆盖。主 Agent 在可安全落档时保存终版，之后工具拒绝继续修改本轮；后续新任务使用新 roundId，复用历史候选单列。

工具沿用工作区锁、路径与原子 JSON 保存，提交快照前再次核对 draft 是否变化；不启动浏览器、不读取认证、不请求模型。首次失败停止保存链路，保留 draft、上一版和任何部分产物；没有成功回执不能声称新版本已保存。锁因清理未知保留时不得删锁或绕过锁补统计，可保留 draft 并报告“本轮终版持久化待处理”。进程强制结束只保证之前确认保存的快照，不承诺自动从轨迹恢复全部发现。

收尾后加载 qa-test-report，将准确终版概览、完整功能清单及未生成原因与相关 runId 一并交付。纯探索/仅候选无需制造执行批次；回归已有资产不强制重建探索清单。右侧测试报告面板继续展示执行批次，本轮清单通过文件链接交付。
