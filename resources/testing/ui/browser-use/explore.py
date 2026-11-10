"""探针与阶段 2 只读探索；共用严格运行时和进程协议。"""
import asyncio
from importlib.metadata import version
import json
import logging
import os
from pathlib import Path
import re
import sys
import time
import traceback
import urllib.request
from urllib.parse import urlsplit

os.environ.update({
    "ANONYMIZED_TELEMETRY": "false",
    "BROWSER_USE_CLOUD_SYNC": "false",
    "BROWSER_USE_SETUP_LOGGING": "false",
    "BROWSER_USE_CLOUD_HINTS": "false",
})
logging.disable(logging.CRITICAL)
from browser_use import Agent, Browser, BrowserProfile, ChatOpenAI, Tools
import psutil

PROBE_EXCLUDED_ACTIONS = [
    "search", "go_back", "wait", "input", "upload_file", "switch", "close", "extract",
    "search_page", "find_elements", "scroll", "send_keys", "find_text", "screenshot",
    "save_as_pdf", "dropdown_options", "select_dropdown", "write_file", "replace_file", "read_file", "evaluate",
]


def matches_control(target, ancestors, rule):
    if target is None:
        return False
    if rule.get("role") and target.get("role") != rule["role"]:
        return False
    if rule.get("name") and target.get("name") != rule["name"]:
        return False
    if not all(target["attributes"].get(k) == v for k, v in rule.get("attributes", {}).items()):
        return False
    container = rule.get("ancestor", {}).get("attributes")
    return not container or any(all(node["attributes"].get(k) == v for k, v in container.items()) for node in ancestors)


def project_url(message, address):
    base, url = urlsplit(message["address"]), urlsplit(address)
    prefix = base.path.rstrip("/")
    return (url.scheme in ("http", "https") and url.netloc == base.netloc and url.scheme == base.scheme
            and not url.username and not url.password
            and (not prefix or url.path == prefix or url.path.startswith(prefix + "/")))


def readonly_guard(message, data, target, ancestors, visible):
    name = next(iter(data))
    values = data[name]
    contract = message["contract"]
    observed = {"identityConfirmed": contract["identity"]["text"] in visible,
                "completionConfirmed": all(text in visible for text in contract["completionTexts"])}
    if name == "navigate":
        if not project_url(message, values.get("url", "")):
            raise ValueError("outside-project-navigation")
    elif name == "done":
        if not all(observed.values()) or values.get("success") is not True:
            raise ValueError("identity-or-business-result-not-observed")
    else:
        if "coordinate_x" in values or "coordinate_y" in values or values.get("clear") is False:
            raise ValueError("coordinate-or-append-forbidden")
        if not observed["identityConfirmed"]:
            raise ValueError("identity-not-observed")
        rules = [rule for rule in contract["controls"] if rule["action"] == name and matches_control(target, ancestors, rule)]
        if not rules:
            raise ValueError("undeclared-readonly-control")
        if name != "click" and not any(values.get("text") in rule.get("values", []) for rule in rules):
            raise ValueError("undeclared-filter-value")
    return observed


def configure_loopback_proxy_bypass(direct_model_host=None):
    # macOS 的系统代理也会被 websockets 自动读取；只在子进程内配置直连例外。
    # 先保留已解析的代理，避免只设置 no_proxy 后遮蔽系统的外网代理。
    proxies = urllib.request.getproxies()
    for scheme, address in proxies.items():
        if scheme != "no":
            os.environ.setdefault(f"{scheme}_proxy", address)
    # 仅对用户确认应直连的模型主机追加例外，不把全部内网或外网改为直连。
    bypass = ",".join(filter(None, [proxies.get("no"), "127.0.0.1", "localhost", "::1", direct_model_host]))
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
    if version("browser-use") != "0.13.14+swqa.1":
        raise RuntimeError("patched-runtime-required")
    configure_loopback_proxy_bypass(message.get("directModelHost"))
    output = Path(message["output"])
    evidence = output / "evidence"
    evidence.mkdir(exist_ok=True)
    mode = message.get("mode", "explore")
    readonly = message.get("workflow") == "browser-use-playwright"
    browser = Browser(browser_profile=BrowserProfile(launch_max_attempts=1, auto_reconnect=False,
                                                    user_data_dir=str(output / "private" / "profile")),
                      executable_path=message["chromium"], headless=True,
                      storage_state=message["storageState"],
                      downloads_path=str(output / "private" / "downloads"),
                      allowed_domains=[urlsplit(message["url"]).hostname] if readonly else ["127.0.0.1"], enable_default_extensions=False,
                      keep_alive=False, auto_download_pdfs=False)
    model = ProbeModel(message.get("model"), mode)
    pending = None
    records = 0
    owned = []
    cancelled = False
    result = {"status": "failed"}
    step_errors = []
    reconnect_attempts = 0
    browser_fault = asyncio.get_running_loop().create_future()

    def on_browser_error(event):
        if not browser_fault.done():
            browser_fault.set_result(event.error_type)

    def on_reconnecting(event):
        nonlocal reconnect_attempts
        reconnect_attempts += 1
        if not browser_fault.done():
            browser_fault.set_result("unexpected-reconnect")

    browser.event_bus.on("BrowserErrorEvent", on_browser_error)
    browser.event_bus.on("BrowserReconnectingEvent", on_reconnecting)
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
        allowed = ("navigate", "click", "input", "select_dropdown", "done") if readonly else ("navigate", "click", "done")
        if name not in allowed:
            raise ValueError(f"unsupported-probe-action:{name}")
        if not readonly and name == "navigate" and data[name].get("url") != message["url"]:
            raise ValueError("unexpected-probe-url")
        target = state.dom_state.selector_map.get(action.get_index())
        if name not in ("navigate", "done") and target is None:
            raise ValueError("missing-target")
        visible = state.dom_state.llm_representation()
        observed = {"identityConfirmed": "smoke-reviewer" in visible,
                    "asyncResultVisible": "Beta · ready" in visible}
        if not readonly and name == "done" and not all(observed.values()):
            raise ValueError("business-result-not-observed")
        ancestors = []
        parent = target.parent_node if target else None
        while parent is not None and len(ancestors) < 6:
            ancestors.append(describe(parent))
            parent = parent.parent_node
        if readonly:
            if name != "navigate" and not project_url(message, state.url):
                raise ValueError("outside-project-page")
            if target and target.attributes.get("type") == "password":
                raise ValueError("password-input-forbidden")
            observed = readonly_guard(message, data, describe(target), ancestors, visible)
        ref = None
        if name != "navigate":
            # 默认逐步截图已关闭；仅在声明的关键节点主动留证。
            screenshot = await browser.take_screenshot(full_page=False)
            if not screenshot:
                raise ValueError("missing-key-evidence")
            ref = f"evidence/before-{step}.png"
            (output / ref).write_bytes(screenshot)
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
        if mode == "disconnect-probe":
            # 受控负例：关闭实际 CDP 连接，零模型调用地验证停止与收尾。
            stage = "disconnect-probe"
            await browser.cdp_client.ws.close()
            await asyncio.wait_for(asyncio.shield(browser_fault), timeout=5)
            return {"status": "failed", "reason": "browser-error", "browserError": browser_fault.result()}
        goal = message["goal"]
        if readonly:
            goal += "\nFrozen exploration contract: " + json.dumps(message["contract"], ensure_ascii=False)
            goal += "\nOpen " + message["url"] + "."
            # 以随包入口定位，避免依赖任务 cwd 或开发机路径；每次任务读取最新正文。
            instructions = (Path(__file__).parent.parent / "prompt" / "exploration-control.md").read_text(encoding="utf-8").strip()
            if not instructions:
                raise ValueError("empty-exploration-control")
            goal += "\n" + instructions + "\n"
        agent = Agent(task=goal, llm=model, browser_session=browser,
                      register_new_step_callback=before, use_vision=False, capture_screenshots=False,
                      max_failures=1, final_response_after_failure=False,
                      max_actions_per_step=1, use_judge=False, use_thinking=False,
                      enable_planning=False, message_compaction=False,
                      directly_open_url=False, generate_gif=False,
                      save_conversation_path=None, calculate_cost=False,
                      enable_signal_handler=False, llm_timeout=50, step_timeout=75,
                      file_system_path=str(output / "private" / "files"),
                      tools=Tools(exclude_actions=[name for name in PROBE_EXCLUDED_ACTIONS if not readonly or name not in ("input", "select_dropdown")]))
        history = await agent.run(max_steps=message["contract"]["budget"]["maxSteps"] if readonly else 8, on_step_start=step_start, on_step_end=step_end)
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
        ready, _ = await asyncio.wait([work, cancel, browser_fault], timeout=message["contract"]["budget"]["timeoutMs"] / 1000 if readonly else 180,
                                      return_when=asyncio.FIRST_COMPLETED)
        if browser_fault in ready:
            work.cancel()
            await asyncio.gather(work, return_exceptions=True)
            result = {"status": "failed", "reason": "browser-error", "browserError": browser_fault.result()}
        elif cancel in ready or not ready:
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
        browser_fault.cancel()
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
             reconnectAttempts=reconnect_attempts, cleanupConfirmed=cleanup_confirmed)
    return result


if __name__ == "__main__":
    initial = json.loads(sys.stdin.readline())
    task_id = initial["taskId"]
    try:
        readonly = initial.get("workflow") == "browser-use-playwright"
        if initial.get("type") != "start" or (not readonly and not initial["url"].startswith("http://127.0.0.1:")):
            raise ValueError("local-probe-only")
        final = asyncio.run(run(initial))
        sys.exit(0 if final["status"] in ("completed", "cancelled") else 1)
    except Exception as error:
        emit("error", reason=type(error).__name__)
        sys.exit(1)
