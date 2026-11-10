import fs from "node:fs/promises";
import path from "node:path";

const text = (value) => typeof value === "string" && value.trim().length > 0;
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
function check(condition, message) { if (!condition) throw new Error(message); }
const ratio = (count, total) => total === 0 ? null : Math.round(count / total * 10000) / 100;
const cell = (value) => String(value ?? "—").replaceAll("|", "\\|").replaceAll("\n", " ");

function report(snapshot) {
  const { manifest, counts } = snapshot;
  const rate = counts.conversionRate === null ? "不适用" : `${counts.conversionRate}%`;
  return [
    `# UI 本轮功能与候选汇总 ${snapshot.roundId}`, "",
    `版本：${snapshot.revision}；状态：${manifest.status}；统计截止：${snapshot.savedAt}。`,
    `目标：${manifest.goal}；预算：${manifest.budget}；停止依据：${manifest.stopReason || "仍在进行"}。`, "",
    `已登记功能 ${counts.features}；已确认 ${counts.confirmedFeatures}；待确认 ${counts.pendingFeatures}。`,
    `范围内已确认功能 ${counts.eligibleFeatures}；其中本轮生成候选的功能 ${counts.generatedFeatures}；功能点用例转换率 ${rate}。`,
    `范围内待确认功能 ${counts.pendingInScope}；未纳入生成范围 ${counts.outOfScopeFeatures}。`,
    `本轮生成 ${counts.generatedCases} 条候选；历史复用 ${counts.reusedCases} 条；修订不重复计数。`,
    `范围内检查项 ${counts.plannedChecks}；已有候选 ${counts.checksWithCandidate}；尚缺 ${counts.missingChecks}。`, "",
    "转换率只衡量范围内已确认功能是否至少生成一条候选，不表示该功能的全部检查项已完成。历史复用单列，不计本轮生成。",
    "静态保存不证明语义覆盖完整或测试通过；本清单仅覆盖本轮登记范围，不代表全站覆盖。", "",
    "| 功能编号 / 模块 / 功能 | 角色 / 初态 / 分支 | 确认 / 探索 | 生成范围及原因 | 检查项 / 目标 | 候选版本 / 来源 | 验证 / 发布 | 缺口 | 证据 |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...manifest.features.flatMap((feature) => {
      const checks = feature.checks.length ? feature.checks : [{ checkId: "—", goal: "未纳入设计", reason: feature.scopeReason }];
      return checks.map((item) => {
        const mapped = snapshot.mappings.find((entry) => entry.checkId === item.checkId);
        return `| ${[
          `${feature.featureId} / ${feature.modulePath.join(" / ")} / ${feature.name}`,
          `${feature.role} / ${feature.initialState} / ${feature.branch}`,
          `${feature.confirmation} / ${feature.exploration}`,
          `${feature.inScope ? "范围内" : "范围外"}：${feature.scopeReason}`,
          `${item.checkId} / ${item.goal}`,
          mapped ? `${mapped.caseId}@${mapped.revision} / ${mapped.origin} / ${mapped.taskId}` : "未生成",
          mapped ? `${mapped.validationStatus}${mapped.validationRunId ? ` (${mapped.validationRunId})` : ""} / ${mapped.published ? "已发布" : "未发布"}` : "未验证 / 未发布",
          mapped ? "—" : item.reason,
          feature.sources.map((source) => `${source.taskId || "资料"}：${source.path}`).join("；"),
        ].map(cell).join(" | ")} |`;
      });
    }), "",
    "来源为本版本 manifest、准确候选文件哈希和验证摘要；后续运行、发布、删除不会改写此快照。",
  ].join("\n");
}

// 由工作流注入同一把工作区锁及已有任务、版本读取器，不另建资产来源。
export async function recordCoverage(root, params, signal, io) {
  signal?.throwIfAborted();
  const { id, directory, fileAt, writeJson, boundTask, revision } = io;
  id(params.roundId);
  check(["save", "read"].includes(params.action), "清单 action 必须为 save 或 read。");
  const roundDir = params.action === "save"
    ? await directory(root.base, "rounds", params.roundId)
    : path.dirname(path.dirname(await fileAt(root.base, "rounds", params.roundId, "0001", "summary.json")));
  const entries = await fs.readdir(roundDir, { withFileTypes: true });
  const versions = entries.filter((entry) => /^\d{4}$/.test(entry.name)).sort((a, b) => a.name.localeCompare(b.name));
  check(versions.every((entry) => entry.isDirectory() && !entry.isSymbolicLink()), "清单版本目录无效。");
  const read = async (number) => {
    check(/^\d{4}$/.test(number), "清单 revision 必须为四位数字。");
    const snapshot = JSON.parse(await fs.readFile(await fileAt(roundDir, number, "summary.json"), "utf8"));
    check(snapshot.schema === "qa-ui-coverage/v1" && snapshot.roundId === params.roundId && snapshot.revision === number &&
      snapshot.workspace === root.workspace, "清单快照归属不一致。");
    return snapshot;
  };
  if (params.action === "read") {
    check(versions.length > 0, "缺少已保存清单，无法计算。");
    const number = params.revision ?? versions.at(-1).name;
    const snapshot = await read(number);
    return { roundId: params.roundId, revision: number, status: snapshot.manifest.status, counts: snapshot.counts,
      summaryFile: await fileAt(roundDir, number, "summary.json"), summaryDocument: await fileAt(roundDir, number, "summary.md") };
  }
  check(params.revision === undefined, "保存时通过 draft.baseRevision 校验，不接受 revision。");
  const previous = versions.length ? await read(versions.at(-1).name) : null;
  check(!previous || previous.manifest.status === "active", "本轮已经收尾，不能改写冻结清单。");
  const draftBytes = await fs.readFile(await fileAt(roundDir, "draft.json"));
  const draft = JSON.parse(draftBytes.toString("utf8"));
  check(draft.schema === "qa-ui-round/v1" && draft.roundId === params.roundId && text(draft.projectId), "本轮清单格式或项目编号无效。");
  check(draft.baseRevision === (previous?.revision ?? null), "清单版本已变化，请核对已保存版本。");
  check(["explore", "candidate", "complete"].includes(draft.mode) && text(draft.goal) && text(draft.budget), "清单缺少模式、目标或总预算。");
  check(["active", "completed", "partial"].includes(draft.status) && (draft.status === "active" || text(draft.stopReason)), "收尾必须记录完成或部分探索及停止依据。");
  check(Array.isArray(draft.taskIds) && new Set(draft.taskIds).size === draft.taskIds.length, "本轮 taskIds 必须为非重复清单。");
  check(Array.isArray(draft.features), "缺少完整功能清单，无法计算。");
  if (previous) {
    for (const key of ["projectId", "mode", "goal", "budget"]) check(same(draft[key], previous.manifest[key]), `不能改变本轮 ${key}。`);
    check(previous.manifest.taskIds.every((taskId) => draft.taskIds.includes(taskId)), "不能移除已登记任务。");
    for (const old of previous.manifest.features) {
      const current = draft.features.find((feature) => feature.featureId === old.featureId);
      check(current && (!old.inScope || current.inScope), "不能删除功能或将范围内功能移出分母。");
      check(Array.isArray(current.checks), "缺少已登记的检查目标。");
      for (const key of ["name", "modulePath", "role", "initialState", "branch"]) check(same(current[key], old[key]), `不能改变功能 ${old.featureId} 的 ${key}。`);
      check(old.confirmation !== "confirmed" || current.confirmation === "confirmed", "已确认功能不能降为待确认。");
      for (const item of old.checks) {
        const next = current.checks.find((entry) => entry.checkId === item.checkId);
        check(next && next.goal === item.goal, "不能删除或改变已登记检查目标。");
        check(!item.case || same(next.expectedIds, item.expectedIds), "不能改变已映射检查项的业务预期引用。");
      }
    }
  }
  const tasks = new Map();
  for (const taskId of draft.taskIds) {
    signal?.throwIfAborted();
    const { task } = await boundTask(root, taskId);
    check(task.project?.id === draft.projectId, "本轮任务不属于当前项目。");
    tasks.set(taskId, task);
  }
  const startedAt = previous?.startedAt ?? new Date().toISOString();
  const featureIds = new Set();
  const checkIds = new Set();
  const caseIds = new Set();
  const mappings = [];
  for (const feature of draft.features) {
    id(feature.featureId);
    check(!featureIds.has(feature.featureId), "功能编号重复。");
    featureIds.add(feature.featureId);
    check(text(feature.name) && Array.isArray(feature.modulePath) && feature.modulePath.length > 0 && feature.modulePath.every(text) &&
      ["role", "initialState", "branch", "scopeReason"].every((key) => text(feature[key])), "功能缺少模块、名称、角色、初态、分支或范围依据。");
    check(["confirmed", "pending"].includes(feature.confirmation) && ["identified", "explored", "blocked", "pending"].includes(feature.exploration) &&
      typeof feature.inScope === "boolean" && (draft.mode !== "explore" || !feature.inScope), "功能状态无效，纯探索不能声明候选生成范围。");
    check(Array.isArray(feature.sources) && feature.sources.length > 0 && Array.isArray(feature.checks) &&
      (!feature.inScope || feature.checks.length > 0), "功能须保留来源，范围内功能至少登记一个检查目标。");
    let confirmedSource = false;
    for (const source of feature.sources) {
      check(text(source.path) && !path.isAbsolute(source.path) && !source.path.includes("\\") &&
        source.path.split("/").every((part) => part && part !== "." && part !== ".."), "证据必须使用工作区内相对路径。");
      await fileAt(root.workspace, ...source.path.split("/"));
      if (source.taskId) {
        const task = tasks.get(source.taskId);
        check(task && source.path.startsWith(`qa/ui/tasks/${source.taskId}/`), "发现证据必须来自本轮登记任务。");
        if (task.status === "completed" && task.terminal?.cleanupConfirmed === true) confirmedSource = true;
      }
    }
    check(feature.confirmation !== "confirmed" || confirmedSource, "已确认功能必须有成功且清理确认的探索来源。");
    for (const item of feature.checks) {
      id(item.checkId);
      check(!checkIds.has(item.checkId) && text(item.goal), "检查项编号重复或缺少目标。");
      checkIds.add(item.checkId);
      if (!item.case) { check(text(item.reason), "未生成检查项必须保留原因（可注明已设计或受阻）。"); continue; }
      check(feature.inScope && feature.confirmation === "confirmed", "仅范围内已确认功能可以关联候选。");
      check(!caseIds.has(item.case.caseId), "同一 case 的修订不能关联多个独立检查项凑覆盖。");
      caseIds.add(item.case.caseId);
      const selected = await revision(root, item.case.caseId, item.case.revision);
      const { asset, entry, meta } = selected;
      const sourceTaskId = entry.baseTaskId ?? entry.taskId;
      const { task } = await boundTask(root, sourceTaskId);
      check(asset.origin !== "manual" && meta.schema === "qa-ui-case/v1" && meta.caseId === asset.caseId &&
        meta.taskId === sourceTaskId && meta.project?.id === draft.projectId && task.project?.id === draft.projectId &&
        task.status === "completed" && task.contract.mode !== "explore" && meta.role === feature.role && meta.targetUrl === task.targetUrl &&
        same(meta.expected, task.contract.expected), "候选与功能角色、项目或成功探索来源不一致，手动设计稿不计生成。");
      check(Array.isArray(item.expectedIds) && item.expectedIds.length > 0 && new Set(item.expectedIds).size === item.expectedIds.length &&
        item.expectedIds.every((expectedId) => meta.expected.some((expected) => expected.id === expectedId) &&
          meta.assertions?.some((assertion) => assertion.kind === "business" && assertion.expectedId === expectedId && text(assertion.text))),
      "功能映射必须引用该版本实际业务预期及断言。");
      const origin = tasks.has(sourceTaskId) && Date.parse(task.startedAt) >= Date.parse(startedAt) ? "generated" : "reused";
      let validationStatus = "not-run";
      const validationRunId = entry.validatedRunId ?? entry.validationRunId;
      if (validationRunId) {
        id(validationRunId);
        let run;
        try { run = JSON.parse(await fs.readFile(await fileAt(root.base, "runs", validationRunId, "summary.json"), "utf8")); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
        if (run) {
          check(run.workflow === "browser-use-playwright" && run.purpose === "validate" && run.workspace === root.workspace &&
            run.project?.id === draft.projectId && run.runId === validationRunId && run.revisions?.[meta.caseId] === entry.revision &&
            run.sourceTaskIds?.[meta.caseId] === entry.taskId && ["passed", "failed", "incomplete", "cancelled"].includes(run.status), "验证结果与准确版本不匹配。");
        }
        validationStatus = run?.status ?? "unknown";
      }
      mappings.push({ featureId: feature.featureId, checkId: item.checkId, caseId: meta.caseId, revision: entry.revision,
        expectedIds: item.expectedIds, taskId: entry.taskId, sourceTaskId, hashes: entry.hashes, origin,
        validationRunId: validationRunId ?? null, validationStatus,
        published: asset.currentRevision === entry.revision && Boolean(entry.validatedRunId) && validationStatus === "passed" });
    }
  }
  signal?.throwIfAborted();
  const eligible = draft.features.filter((feature) => feature.inScope && feature.confirmation === "confirmed");
  const generatedFeatures = eligible.filter((feature) => mappings.some((item) => item.featureId === feature.featureId && item.origin === "generated")).length;
  const plannedChecks = draft.features.filter((feature) => feature.inScope).reduce((sum, feature) => sum + feature.checks.length, 0);
  const counts = { features: draft.features.length, confirmedFeatures: draft.features.filter((feature) => feature.confirmation === "confirmed").length,
    pendingFeatures: draft.features.filter((feature) => feature.confirmation === "pending").length,
    eligibleFeatures: eligible.length, generatedFeatures, conversionRate: draft.mode === "explore" ? null : ratio(generatedFeatures, eligible.length),
    pendingInScope: draft.features.filter((feature) => feature.inScope && feature.confirmation === "pending").length,
    outOfScopeFeatures: draft.features.filter((feature) => !feature.inScope).length,
    generatedCases: mappings.filter((item) => item.origin === "generated").length, reusedCases: mappings.filter((item) => item.origin === "reused").length,
    plannedChecks, checksWithCandidate: mappings.length, missingChecks: plannedChecks - mappings.length };
  const number = String(Number(previous?.revision ?? 0) + 1).padStart(4, "0");
  check(number.length === 4, "本轮清单版本数量已达上限。");
  const snapshot = { schema: "qa-ui-coverage/v1", roundId: params.roundId, revision: number, workspace: root.workspace,
    startedAt, savedAt: new Date().toISOString(), manifest: draft, counts, mappings };
  check(draftBytes.equals(await fs.readFile(await fileAt(roundDir, "draft.json"))), "校验期间草稿发生变化，请保留并核对最新内容。");
  const versionDir = await directory(roundDir, number);
  const summaryDocument = path.join(versionDir, "summary.md");
  const summaryFile = path.join(versionDir, "summary.json");
  await fs.writeFile(summaryDocument, report(snapshot), { flag: "wx", mode: 0o600 });
  await writeJson(summaryFile, snapshot);
  return { roundId: params.roundId, revision: number, status: draft.status, counts, summaryFile, summaryDocument };
}
