import { Type } from "typebox";
import { createReadOnlyWorkflow } from "./workflow.mjs";

const string = Type.String({ minLength: 1 });
const attributes = Type.Record(Type.String(), string);
const contract = Type.Object({
  mode: Type.Union([Type.Literal("explore"), Type.Literal("candidate"), Type.Literal("complete")]),
  goal: string, role: string,
  identity: Type.Object({ selector: string, text: string }),
  expected: Type.Array(Type.Object({ id: string, text: string,
    source: Type.Object({ kind: Type.Union([Type.Literal("user"), Type.Literal("rule"), Type.Literal("baseline")]), reference: string }) }), { minItems: 1 }),
  initialState: string, dataStrategy: Type.Union([Type.Literal("read-only"), Type.Literal("isolated-write")]),
  cleanup: Type.Union([Type.Literal("none"), Type.Literal("in-test"), Type.Literal("residual")]),
  writeAuthorization: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("user"), Type.Literal("rule"), Type.Literal("baseline")]), reference: string,
  })),
  residualAuthorization: Type.Optional(Type.Object({
    kind: Type.Union([Type.Literal("user"), Type.Literal("rule"), Type.Literal("baseline")]), reference: string,
  })),
  completionTexts: Type.Array(string, { minItems: 1 }),
  controls: Type.Array(Type.Object({
    action: Type.Union([Type.Literal("click"), Type.Literal("input"), Type.Literal("select_dropdown")]),
    role: Type.Optional(string), name: Type.Optional(string), attributes: Type.Optional(attributes),
    ancestor: Type.Optional(Type.Object({ attributes })), values: Type.Optional(Type.Array(string)),
  }), { minItems: 1 }),
  provider: string, modelId: string,
  budget: Type.Object({ maxSteps: Type.Integer({ minimum: 1, maximum: 12 }), timeoutMs: Type.Integer({ minimum: 1000, maximum: 180000 }) }),
});

// 生产会话与独立检查共用工作流入口。
export function createUiTestingExtension(runtime) {
  return (pi) => {
    const workflow = createReadOnlyWorkflow(runtime);
    const active = new Map();
    pi.on("resources_discover", () => ({
      skillPaths: [runtime.skill, runtime.designSkill, runtime.assertionSkill, runtime.executeSkill, runtime.reportSkill],
    }));
    const register = (name, description, parameters, method) => pi.registerTool({
      name, label: name, description, parameters, executionMode: "sequential",
      async execute(toolCallId, params, signal, onUpdate, ctx) {
        const controller = new AbortController();
        const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
        const promise = workflow[method](ctx.cwd, params, combined, (event) => {
          if (event.type === "progress") onUpdate?.({ content: [{ type: "text", text: `探索：${event.phase}` }], details: { taskId: event.taskId, phase: event.phase } });
        });
        active.set(toolCallId, { controller, promise });
        try {
          const details = await promise;
          return { content: [{ type: "text", text: JSON.stringify(details, null, 2) }], details };
        } finally { active.delete(toolCallId); }
      },
    });
    register("qa_ui_explore", "只读探索：匹配项目、后台登录并记录任务轨迹。必须明确 Pi 模型和业务预期来源；不生成脚本。", Type.Object({
      targetUrl: string, projectId: Type.Optional(string), projectName: Type.Optional(string), contract,
    }), "explore");
    register("qa_ui_save_candidate", "将 drafts/<caseId>/case.spec.cjs 和 case.json 静态检查并冻结为候选版本；不执行。只传 caseId+baseRevision+parentRunId 时，根据失败的回归批次建立已有用例的修复任务并返回 taskId 与草稿目录，不启动浏览器；后续补丁沿用该 taskId。", Type.Object({
      taskId: Type.Optional(string), caseId: string,
      baseRevision: Type.Optional(string), parentRunId: Type.Optional(string), patchSummary: Type.Optional(string),
    }), "saveCandidate");
    register("qa_ui_run", "独立回放准确 revision。validate 仅完整测试任务可执行候选；regression 只执行当前正式版本。", Type.Object({
      caseId: string, revision: string, mode: Type.Union([Type.Literal("validate"), Type.Literal("regression")]),
    }), "run");
    register("qa_ui_publish", "读取真实原生报告、版本哈希、初态及业务截图；只有准确版本验证通过才发布。", Type.Object({ caseId: string, revision: string, runId: string }), "publish");
    register("qa_ui_coverage", "保存本轮功能清单或读取准确版本汇总。save 从 qa/ui/rounds/<roundId>/draft.json 校验来源、候选映射和 baseRevision，保留未生成项并写入不可改写的快照；不探索、不执行。read 读取已保存快照，不以当前资产重算历史。", Type.Object({
      roundId: string, action: Type.Union([Type.Literal("save"), Type.Literal("read")]), revision: Type.Optional(string),
    }), "coverage");
    pi.on("session_shutdown", async () => {
      const pending = [...active.values()];
      for (const item of pending) item.controller.abort();
      await Promise.allSettled(pending.map((item) => item.promise));
    });
  };
}
