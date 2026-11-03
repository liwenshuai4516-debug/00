// 手动诊断资源来源，不创建会话或请求模型；reload 会执行已启用的扩展工厂。
import { SettingsManager, DefaultResourceLoader, getAgentDir } from "@mariozechner/pi-coding-agent";

const cwd = process.cwd();
const agentDir = getAgentDir();
const settingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager });
await loader.reload();
const brief = item => ({
  name: item.name,
  source: item.sourceInfo?.source,
  scope: item.sourceInfo?.scope,
  origin: item.sourceInfo?.origin,
  baseDir: item.sourceInfo?.baseDir,
});
const skills = loader.getSkills().skills.map(brief);
const prompts = (loader.getPrompts?.().prompts ?? []).map(brief);
const exts = loader.getExtensions().extensions.map(e => ({ ...brief(e), path: e.path }));
const uniq = (arr, key) => [...new Set(arr.map(x => x[key]))];
console.log("技能来源", uniq(skills, "source"));
console.log("技能配置范围", uniq(skills, "scope"));
console.log("提示词模板来源", uniq(prompts, "source"));
console.log("扩展来源", uniq(exts, "source"));
console.log("扩展配置范围", uniq(exts, "scope"));
console.log("非个人技能示例", JSON.stringify(skills.filter(x => x.scope !== "user").slice(0, 10), null, 2));
console.log("扩展示例", JSON.stringify(exts.slice(0, 8), null, 2));
