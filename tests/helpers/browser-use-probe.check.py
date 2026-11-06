"""不启动浏览器、不读取真实配置、不请求模型的探针行为检查。"""
import importlib.util
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, patch

entry = Path(__file__).resolve().parents[2] / "resources/testing/ui/browser-use/explore.py"
spec = importlib.util.spec_from_file_location("browser_use_probe", entry)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)
probe.task_id = "offline-check"


class ProbeChecks(unittest.IsolatedAsyncioTestCase):
    def test_local_cdp_bypasses_system_socks_without_losing_remote_proxy(self):
        from websockets.uri import get_proxy, parse_uri
        proxies = {"socks": "http://proxy.invalid:1080", "https": "http://proxy.invalid:8080", "no": "existing.invalid"}
        with patch.dict(os.environ, {}, clear=True), patch.object(probe.urllib.request, "getproxies", return_value=proxies):
            probe.configure_loopback_proxy_bypass()
            self.assertEqual(os.environ["https_proxy"], proxies["https"])
            self.assertIn("existing.invalid", os.environ["no_proxy"])
            # 真实 urllib / websockets 解析环境，不连接任何服务器。
            with patch.object(probe.urllib.request, "getproxies", side_effect=probe.urllib.request.getproxies_environment):
                for host in ["127.0.0.1", "localhost", "[::1]"]:
                    self.assertIsNone(get_proxy(parse_uri(f"ws://{host}:1234/")))
                self.assertEqual(get_proxy(parse_uri("wss://remote.invalid/")), "socks5h://proxy.invalid:1080")

    async def test_empty_response_stops_before_sdk_retry(self):
        model = probe.ProbeModel(None, "explore")
        model.client = SimpleNamespace(ainvoke=AsyncMock(return_value=SimpleNamespace(
            completion=SimpleNamespace(action=[]), usage=None)))
        with self.assertRaisesRegex(ValueError, "expected-one-action"):
            await model.ainvoke([])
        with self.assertRaisesRegex(RuntimeError, "model-retry-forbidden"):
            await model.ainvoke([])
        self.assertEqual(model.client.ainvoke.await_count, 1)
        self.assertEqual(model.calls, 1)

    async def test_multi_action_response_is_rejected(self):
        model = probe.ProbeModel(None, "explore")
        model.client = SimpleNamespace(ainvoke=AsyncMock(return_value=SimpleNamespace(
            completion=SimpleNamespace(action=[object(), object()]), usage=None)))
        with self.assertRaisesRegex(ValueError, "expected-one-action"):
            await model.ainvoke([])
        self.assertEqual(model.client.ainvoke.await_count, 1)

    async def test_valid_response_preserves_available_usage(self):
        model = probe.ProbeModel(None, "explore")
        action = SimpleNamespace(model_dump=lambda **kwargs: {"done": {"success": True}})
        response = SimpleNamespace(completion=SimpleNamespace(action=[action]),
                                   usage=SimpleNamespace(model_dump=lambda: {"total_tokens": 10}))
        model.client = SimpleNamespace(ainvoke=AsyncMock(return_value=response))
        self.assertIs(await model.ainvoke([]), response)
        self.assertEqual(model.usage, [{"total_tokens": 10}])

    async def exercise_lifecycle(self, cancel=False, cleanup_error=False, startup_error="injected", model=None):
        browser = SimpleNamespace(start=AsyncMock(side_effect=None if cancel else RuntimeError(startup_error)),
                                  kill=AsyncMock(side_effect=RuntimeError("injected") if cleanup_error else None),
                                  event_bus=SimpleNamespace(event_history={"event": SimpleNamespace(
                                      event_id="event", event_parent_id=None, event_type="BrowserStartEvent", event_status="error",
                                      event_results={"handler": SimpleNamespace(handler_name="BrowserSession.on_BrowserStartEvent",
                                                                             status="error", result="must-not-export")})}))
        read_fd, write_fd = os.pipe()
        records = []
        def emit(kind, **values):
            records.append({"type": kind, **values})
            if values.get("phase") == "browser-ready":
                os.write(write_fd, b'{"type":"cancel","taskId":"offline-check"}\n')
        try:
            with tempfile.TemporaryDirectory() as directory, os.fdopen(read_fd) as stream:
                with patch.object(probe, "Browser", return_value=browser), patch.object(probe.sys, "stdin", stream), patch.object(probe, "emit", side_effect=emit):
                    result = await probe.run({"output": directory, "chromium": "unused", "storageState": {},
                                              "mode": "cancel-probe", "url": "http://127.0.0.1:1/", "model": model})
            return browser, result, records
        finally:
            os.close(write_fd)

    async def test_initialization_failure_is_terminal_and_cleaned(self):
        browser, result, records = await self.exercise_lifecycle()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stage"], "browser-start")
        self.assertTrue(result["frames"])
        self.assertEqual(result["detail"], "injected")
        self.assertEqual(result["startupEvents"][0]["type"], "BrowserStartEvent")
        self.assertNotIn("result", result["startupEvents"][0]["handlers"][0])
        self.assertEqual(records[-1]["modelCalls"], 0)
        self.assertTrue(records[-1]["cleanupConfirmed"])
        browser.start.assert_awaited_once()
        browser.kill.assert_awaited_once()

    async def test_cancel_waits_for_cleanup(self):
        browser, result, records = await self.exercise_lifecycle(cancel=True)
        self.assertEqual(result["status"], "cancelled")
        self.assertTrue(records[-1]["cleanupConfirmed"])
        browser.kill.assert_awaited_once()

    async def test_cleanup_failure_is_unknown(self):
        _, result, records = await self.exercise_lifecycle(cleanup_error=True)
        self.assertEqual(result["status"], "unknown")
        self.assertFalse(records[-1]["cleanupConfirmed"])

    async def test_startup_diagnostics_redact_proxy_and_model_credentials(self):
        model = {"model": "offline", "api_key": "test-secret", "default_headers": {"X-Test": "header-secret"}}
        _, result, records = await self.exercise_lifecycle(
            startup_error="socks5h://user:password@proxy.invalid test-secret header-secret", model=model)
        self.assertEqual(result["detail"], "socks5h://[redacted]@proxy.invalid [redacted] [redacted]")
        self.assertEqual(records[-1]["modelCalls"], 0)


if __name__ == "__main__":
    unittest.main()
