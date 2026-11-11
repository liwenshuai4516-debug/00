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
    register("qa_ui_approval", "审批专用分支。instructions 读取规则；preflight 仅检查认证配置；prepare 显式修订零执行步骤计划并保留版本；inspect 按 before 等待页面就绪再观察控件，创建入口须 createsRecord:true；execute 冻结配置并隔离执行一个节点；reconcile 只读核对；candidate 依据完整终态轨迹准备 E2E 草稿。凭据只由宿主处理。", Type.Object({
      operation: Type.Union(["instructions", "preflight", "prepare", "inspect", "execute", "reconcile", "candidate"].map(value => Type.Literal(value))),
      flowId: Type.Optional(string), targetUrl: Type.Optional(string), projectId: Type.Optional(string),
      baseRevision: Type.Optional(Type.Integer({ minimum: 0 })),
      config: Type.Optional(Type.Object({
        source: string, residualAuthorization: Type.Object({ kind: Type.Union([Type.Literal("user"), Type.Literal("rule"), Type.Literal("baseline")]), reference: string }), record: Type.Object({ selector: string, text: string, kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("value")])) }),
        actors: Type.Array(Type.Object({ id: string, account: string, source: string,
          credentialSource: Type.Union([Type.Literal("project"), Type.Literal("test-password")]),
          identity: Type.Object({ selector: string, text: string }),
          login: Type.Optional(Type.Object({ account: Type.Optional(string), password: Type.Optional(string), submit: Type.Optional(string),
            tenant: Type.Optional(Type.Object({ selector: string, confirm: string })) })),
        }), { minItems: 1 }),
      })),
      step: Type.Optional(Type.Object({
        actorId: string, url: string, id: Type.Optional(string), name: Type.Optional(string), source: Type.Optional(string),
        before: Type.Optional(Type.Array(Type.Object({ selector: string, text: string, kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("value")])) }))),
        after: Type.Optional(Type.Array(Type.Object({ selector: string, text: string, kind: Type.Optional(Type.Union([Type.Literal("text"), Type.Literal("value")])) }))),
        actions: Type.Optional(Type.Array(Type.Object({ kind: Type.Union(["click", "fill", "select", "upload"].map(value => Type.Literal(value))), selector: string, value: Type.Optional(string), file: Type.Optional(string) }))),
        capture: Type.Optional(Type.Object({ name: string, query: Type.Optional(string), selector: Type.Optional(string), attribute: Type.Optional(string) })),
        createsRecord: Type.Optional(Type.Boolean()), terminal: Type.Optional(Type.Boolean()),
      })), previousStepId: Type.Optional(string),
      authorization: Type.Optional(Type.Object({ kind: Type.Union([Type.Literal("user"), Type.Literal("rule"), Type.Literal("baseline")]), reference: string })),
      caseId: Type.Optional(string), title: Type.Optional(string), modulePath: Type.Optional(Type.Array(string)), contract: Type.Optional(contract),
    }), "approval");
    pi.on("session_shutdown", async () => {
      const pending = [...active.values()];
      for (const item of pending) item.controller.abort();
      await Promise.allSettled(pending.map((item) => item.promise));
    });
  };
}
