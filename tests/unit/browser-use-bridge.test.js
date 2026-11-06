const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { startProbe } = require("../../resources/testing/ui/browser-use/bridge.cjs");

async function fixture(t, body) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "browser-use-bridge-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const executable = path.join(directory, "python-fixture");
  await fs.writeFile(executable, `#!${process.execPath}\nconst {createInterface}=require("node:readline");
const lines=createInterface({input:process.stdin});
let start;
function emit(value){process.stdout.write(JSON.stringify({taskId:start.taskId,...value})+"\\n");}
lines.on("line",line=>{const message=JSON.parse(line); if(!start){start=message;${body}}else if(message.type==="cancel"){emit({type:"done",status:"cancelled",cleanupConfirmed:true});lines.close();process.stdin.destroy();}});
`, { mode: 0o700 });
  return { python: executable, message: { taskId: "probe", type: "start", output: directory }, timeoutMs: 2000 };
}

test("done 与零退出码及浏览器收尾共同确认完成", async (t) => {
  const options = await fixture(t, 'emit({type:"done",status:"completed",cleanupConfirmed:true});');
  const result = await startProbe(options).completed;
  assert.equal(result.code, 0);
  assert.equal(result.terminal.status, "completed");
});

test("有 done 但非零退出不能当作成功", async (t) => {
  const options = await fixture(t, 'emit({type:"done",status:"completed",cleanupConfirmed:true});process.exitCode=2;');
  await assert.rejects(startProbe(options).completed, (error) => error.result.code === 2);
});

test("无终值意外退出保留未完成结果", async (t) => {
  const options = await fixture(t, 'process.exit(0);');
  await assert.rejects(startProbe(options).completed, /incomplete-process-result/);
});

test("浏览器收尾未确认不算完成", async (t) => {
  const options = await fixture(t, 'emit({type:"done",status:"completed",cleanupConfirmed:false});');
  await assert.rejects(startProbe(options).completed);
});

test("错误 taskId 立即停止协议链路", async (t) => {
  const options = await fixture(t, 'emit({type:"progress",taskId:"other"});');
  await assert.rejects(startProbe(options).completed, /invalid-protocol/);
});

test("终值后的额外消息拒绝接受", async (t) => {
  const options = await fixture(t, 'emit({type:"done",status:"completed",cleanupConfirmed:true});emit({type:"progress"});');
  await assert.rejects(startProbe(options).completed, /invalid-protocol/);
});

test("取消不等任务完成且等待实际取消终值与退出", async (t) => {
  const options = await fixture(t, 'emit({type:"progress",phase:"ready"});');
  const probe = startProbe({ ...options, onEvent(event) { if (event.phase === "ready") probe.cancel(); } });
  const result = await probe.completed;
  assert.equal(result.terminal.status, "cancelled");
  assert.equal(result.code, 0);
});

test("超过预算触发取消但不把超时记作通过", async (t) => {
  const options = await fixture(t, 'emit({type:"progress"});');
  await assert.rejects(startProbe({ ...options, timeoutMs: 100 }).completed, /timeout/);
});

test("取消未响应时有界终止并保留未确认状态", async (t) => {
  const options = await fixture(t, 'lines.removeAllListeners("line");emit({type:"progress",phase:"ready"});');
  const probe = startProbe({ ...options, cancelGraceMs: 50,
    onEvent(event) { if (event.phase === "ready") probe.cancel(); } });
  await assert.rejects(probe.completed, (error) => error.result.signal === "SIGKILL" && !error.result.terminal);
});
