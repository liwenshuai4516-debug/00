"""阶段 1 探针：仅允许受控本地页面，不注册到正式 Agent 工具。"""
import asyncio
import base64
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import traceback
import urllib.request

os.environ.update({
    "ANONYMIZED_TELEMETRY": "false",
    "BROWSER_USE_CLOUD_SYNC": "false",
    "BROWSER_USE_SETUP_LOGGING": "false",
    "BROWSER_USE_CLOUD_HINTS": "false",
})
logging.disable(logging.CRITICAL)
from browser_use import Agent, Browser, ChatOpenAI, Tools
import psutil


def configure_loopback_proxy_bypass():
    # macOS 的系统代理也会被 websockets 自动读取；仅在子进程内绕过本机地址。
    # 先保留已解析的代理，避免只设置 no_proxy 后遮蔽系统的外网代理。
    proxies = urllib.request.getproxies()
    for scheme, address in proxies.items():
        if scheme != "no":
            os.environ.setdefault(f"{scheme}_proxy", address)
    bypass = ",".join(filter(None, [proxies.get("no"), "127.0.0.1", "localhost", "::1"]))
    os.environ["no_proxy"] = bypass
    os.environ["NO_PROXY"] = bypass


def emit(kind, **values):
    print(json.dumps({"type": kind, "taskId": task_id, **values}), flush=True)


def redact(text, config):
    text = re.sub(r"((?:https?|socks5h?)://)[^/@\s]+@", r"\1[redacted]@", text)
    for secret in [config.get("api_key"), *(config.get("default_headers") or {}).values()]:
        if isinstance(secret, str) and secret:
            text = text.replace(secret, "[redacted]")
    return text


def describe_error(error, config):
    causes = []
    while error is not None and len(causes) < 4:
        causes.append({"type": type(error).__name__, "statusCode": getattr(error, "status_code", None),
                       "detail": redact(str(error), config)[:2000]})
        error = error.__cause__
    return causes


def describe(node):
    if node is None:
        return None
    attrs = {k: v for k, v in node.attributes.items()
             if k in ("id", "role", "aria-label", "data-testid", "data-row")}
    return {"tag": node.node_name, "attributes": attrs,
            "role": node.ax_node.role if node.ax_node else None,
            "name": node.ax_node.name if node.ax_node else None,
            "frameId": node.frame_id}


class ProbeModel:
    """公开 BaseChatModel 协议；在 SDK 的空动作重试之前拒绝无效响应。"""
    provider = "openai"
    model = "offline-probe"
    _verified_api_keys = True

    def __init__(self, config, mode):
        self.mode = mode
        self.calls = 0
        self.step_calls = 0
        self.usage = []
        self.error = None
        self.config = config or {}
        self.client = ChatOpenAI(**config, max_retries=0, timeout=45,
                                 temperature=0, frequency_penalty=None) if config else None
        if config:
            self.model = config["model"]

    @property
    def name(self):
        return self.model

    async def ainvoke(self, messages, output_format=None, **kwargs):
        self.step_calls += 1
        if self.step_calls > 1:
            raise RuntimeError("model-retry-forbidden")
        self.calls += 1
        if self.mode == "error-probe":
            # 预期负例，不请求真实模型，也不执行浏览器写操作。
            raise RuntimeError("injected-model-error")
        try:
            response = await self.client.ainvoke(messages, output_format=output_format, **kwargs)
        except Exception as error:
            self.error = describe_error(error, self.config)
            raise
        self.usage.append(response.usage.model_dump() if response.usage else None)
        actions = getattr(response.completion, "action", None)
        if not actions or len(actions) != 1 or not actions[0].model_dump(exclude_none=True):
            raise ValueError("expected-one-action")
        return response


async def run(message):
    configure_loopback_proxy_bypass()
    output = Path(message["output"])
    evidence = output / "evidence"
    evidence.mkdir(exist_ok=True)
    mode = message.get("mode", "explore")
    browser = Browser(executable_path=message["chromium"], headless=True,
                      storage_state=message["storageState"],
                      user_data_dir=str(output / "private" / "profile"),
                      downloads_path=str(output / "private" / "downloads"),
                      allowed_domains=["127.0.0.1"], enable_default_extensions=False,
                      keep_alive=False, auto_download_pdfs=False)
    model = ProbeModel(message.get("model"), mode)
    pending = None
    records = 0
    owned = []
    cancelled = False
    result = {"status": "failed"}
    step_errors = []
    stage = "browser-start"
    reader = asyncio.StreamReader()
    transport, _ = await asyncio.get_running_loop().connect_read_pipe(
        lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    async def before(state, decision, step):
        nonlocal pending
        action = decision.action[0]
        data = action.model_dump(exclude_none=True, exclude_unset=True)
        name = next(iter(data))
        # 小验证只需要导航、同名按钮点击和完成；拒绝坐标、脚本及其他动作。
        if name not in ("navigate", "click", "done"):
            raise ValueError("unsupported-probe-action")
        if name == "navigate" and data[name].get("url") != message["url"]:
            raise ValueError("unexpected-probe-url")
        target = state.dom_state.selector_map.get(action.get_index())
        if name == "click" and target is None:
            raise ValueError("missing-target")
        visible = state.dom_state.llm_representation()
        observed = {"identityConfirmed": "smoke-reviewer" in visible,
                    "asyncResultVisible": "Beta · ready" in visible}
        if name == "done" and not all(observed.values()):
            raise ValueError("business-result-not-observed")
        ancestors = []
        parent = target.parent_node if target else None
        while parent is not None and len(ancestors) < 6:
            ancestors.append(describe(parent))
            parent = parent.parent_node
        ref = None
        if state.screenshot and (name in ("click", "done") or step == 1):
            ref = f"evidence/before-{step}.png"
            (output / ref).write_bytes(base64.b64decode(state.screenshot))
        pending = {"stepId": str(step), "url": state.url, "action": data,
                   "target": describe(target), "ancestors": ancestors,
                   "observed": observed, "evidence": ref, "startedAt": time.time()}

    async def step_start(agent):
        model.step_calls = 0
        emit("progress", phase="step", step=agent.state.n_steps)

    async def step_end(agent):
        nonlocal pending, records
        results = agent.state.last_result or []
        if pending:
            record = {**pending, "result": [r.model_dump(exclude_none=True) for r in results],
                      "endedAt": time.time()}
            with (output / "actions.jsonl").open("a") as stream:
                stream.write(json.dumps(record) + "\n")
            emit("action", **record)
            records += 1
            pending = None
        if not results or any(r.error for r in results):
            step_errors.extend(redact(r.error, model.config)[:2000] for r in results if r.error)
            agent.stop()
            raise RuntimeError("step-failed-chain-stopped")

    async def execute():
        nonlocal owned, stage
        await browser.start()
        owned = psutil.Process().children(recursive=True)
        emit("progress", phase="browser-ready", browserPids=[p.pid for p in owned])
        stage = "cancel-wait" if mode == "cancel-probe" else "agent-run"
        if mode == "cancel-probe":
            await asyncio.Event().wait()
        agent = Agent(task=message["goal"], llm=model, browser_session=browser,
                      register_new_step_callback=before, use_vision=False,
                      max_failures=1, final_response_after_failure=False,
                      max_actions_per_step=1, use_judge=False, use_thinking=False,
                      enable_planning=False, message_compaction=False,
                      directly_open_url=False, generate_gif=False,
                      save_conversation_path=None, calculate_cost=False,
                      enable_signal_handler=False, llm_timeout=50, step_timeout=75,
                      file_system_path=str(output / "private" / "files"),
                      tools=Tools())
        history = await agent.run(max_steps=8, on_step_start=step_start, on_step_end=step_end)
        if not history.is_done() or not history.is_successful():
            raise RuntimeError("goal-not-completed")
        return {"status": "completed"}

    async def cancellation():
        while True:
            line = await reader.readline()
            if not line:
                return
            msg = json.loads(line)
            if msg.get("type") == "cancel" and msg.get("taskId") == task_id:
                return

    work = asyncio.create_task(execute())
    cancel = asyncio.create_task(cancellation())
    try:
        ready, _ = await asyncio.wait([work, cancel], timeout=180,
                                      return_when=asyncio.FIRST_COMPLETED)
        if cancel in ready or not ready:
            cancelled = cancel in ready
            work.cancel()
            try:
                await work
            except asyncio.CancelledError:
                pass
            result = {"status": "cancelled" if cancelled else "failed",
                      "reason": "cancel-request" if cancelled else "budget-exceeded"}
        else:
            result = await work
    except Exception as error:
        # 模型错误正文可能含请求内容；保留类型和栈位置以便诊断。
        frames = traceback.extract_tb(error.__traceback__)
        result = {"status": "failed", "reason": type(error).__name__, "stage": stage,
                  "modelError": model.error, "stepErrors": step_errors,
                  "frames": [{"file": Path(f.filename).name, "line": f.lineno,
                              "function": f.name} for f in frames]}
        if stage == "browser-start":
            # 此阶段尚未发送模型请求；只保存本地初始化错误并移除认证值。
            result["detail"] = redact(str(error), model.config)[:2000]
            # 关闭会清空事件历史；仅保留状态，不序列化参数、Cookie 或处理结果。
            result["startupEvents"] = [
                {"id": event.event_id, "parentId": event.event_parent_id,
                 "type": event.event_type, "status": event.event_status,
                 "handlers": [{"name": item.handler_name, "status": item.status}
                              for item in event.event_results.values()]}
                for event in browser.event_bus.event_history.values()
            ]
    finally:
        cancel.cancel()
        await asyncio.gather(cancel, return_exceptions=True)
        transport.close()
        # 初始化中途失败时也检查已创建的子进程，不能用空列表冒充收尾。
        owned = list({p.pid: p for p in [*owned, *psutil.Process().children(recursive=True)]}.values())
        cleanup_confirmed = False
        try:
            await browser.kill()
            _, alive = await asyncio.to_thread(psutil.wait_procs, owned, timeout=1)
            cleanup_confirmed = not alive
        except Exception as error:
            result["cleanupError"] = type(error).__name__
        if not cleanup_confirmed:
            result = {**result, "status": "unknown", "reason": "cleanup-unconfirmed"}
        emit("done", **result, modelCalls=model.calls, actions=records, usage=model.usage,
             cleanupConfirmed=cleanup_confirmed)
    return result


if __name__ == "__main__":
    initial = json.loads(sys.stdin.readline())
    task_id = initial["taskId"]
    try:
        if initial.get("type") != "start" or not initial["url"].startswith("http://127.0.0.1:"):
            raise ValueError("local-probe-only")
        final = asyncio.run(run(initial))
        sys.exit(0 if final["status"] in ("completed", "cancelled") else 1)
    except Exception as error:
        emit("error", reason=type(error).__name__)
        sys.exit(1)
