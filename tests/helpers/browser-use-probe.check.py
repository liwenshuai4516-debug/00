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

    async def exercise_lifecycle(self, cancel=False, cleanup_error=False):
        browser = SimpleNamespace(start=AsyncMock(side_effect=None if cancel else RuntimeError("injected")),
                                  kill=AsyncMock(side_effect=RuntimeError("injected") if cleanup_error else None))
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
                                              "mode": "cancel-probe", "url": "http://127.0.0.1:1/"})
            return browser, result, records
        finally:
            os.close(write_fd)

    async def test_initialization_failure_is_terminal_and_cleaned(self):
        browser, result, records = await self.exercise_lifecycle()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["stage"], "browser-start")
        self.assertTrue(result["frames"])
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


if __name__ == "__main__":
    unittest.main()
