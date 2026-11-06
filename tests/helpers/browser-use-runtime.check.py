"""补丁依赖的组件负例；可核对其内部实现，探针运行时仍只使用公开接口。"""
import asyncio
import importlib.metadata
import logging
import os
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import AsyncMock, Mock, patch

temporary = tempfile.TemporaryDirectory(prefix="browser-use-runtime-check-")
os.environ.update({"BROWSER_USE_SETUP_LOGGING": "false", "ANONYMIZED_TELEMETRY": "false",
                   "BROWSER_USE_CLOUD_SYNC": "false", "BROWSER_USE_CONFIG_DIR": temporary.name})
logging.disable(logging.CRITICAL)
from browser_use import Agent, Browser, BrowserProfile, ActionResult, AgentHistoryList
from browser_use.browser.watchdogs.local_browser_watchdog import LocalBrowserWatchdog


class RuntimeChecks(unittest.IsolatedAsyncioTestCase):
    def browser(self, **options):
        profile = BrowserProfile(user_data_dir=Path(temporary.name) / "profile", **options)
        return Browser(browser_profile=profile, executable_path="/unused/chromium")

    def test_public_defaults_and_installed_version(self):
        self.assertEqual(importlib.metadata.version("browser-use"), "0.13.14+swqa.1")
        profile = self.browser().browser_profile
        self.assertEqual(profile.launch_max_attempts, 3)
        self.assertTrue(profile.auto_reconnect)
        with self.assertRaises(ValueError):
            self.browser(launch_max_attempts=0)

    async def test_profile_failure_does_not_launch_again_in_strict_mode(self):
        browser = self.browser(launch_max_attempts=1)
        watchdog = LocalBrowserWatchdog(browser_session=browser, event_bus=browser.event_bus)
        process = SimpleNamespace(pid=123)
        module = "browser_use.browser.watchdogs.local_browser_watchdog"
        original = browser.browser_profile.user_data_dir
        with patch(f"{module}.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=process) as launch, \
             patch(f"{module}.psutil.Process", return_value=process), \
             patch(f"{module}.tempfile.mkdtemp") as new_profile, \
             patch.object(LocalBrowserWatchdog, "_wait_for_cdp_url", new_callable=AsyncMock,
                          side_effect=RuntimeError("user data directory already in use")):
            with self.assertRaisesRegex(RuntimeError, "user data directory already in use"):
                await watchdog._launch_browser()
            launch.assert_awaited_once()
            new_profile.assert_not_called()
        self.assertEqual(browser.browser_profile.user_data_dir, original)

    async def test_default_launch_behavior_is_preserved(self):
        browser = self.browser()
        watchdog = LocalBrowserWatchdog(browser_session=browser, event_bus=browser.event_bus)
        process = SimpleNamespace(pid=123)
        module = "browser_use.browser.watchdogs.local_browser_watchdog"
        with patch(f"{module}.asyncio.create_subprocess_exec", new_callable=AsyncMock, return_value=process) as launch, \
             patch(f"{module}.psutil.Process", return_value=process), \
             patch(f"{module}.tempfile.mkdtemp", return_value=str(Path(temporary.name) / "fallback")), \
             patch(f"{module}.asyncio.sleep", new_callable=AsyncMock), \
             patch.object(LocalBrowserWatchdog, "_wait_for_cdp_url", new_callable=AsyncMock,
                          side_effect=[RuntimeError("user data directory already in use"), "ws://127.0.0.1:1"]):
            _, endpoint = await watchdog._launch_browser()
            self.assertEqual(launch.await_count, 2)
            self.assertEqual(endpoint, "ws://127.0.0.1:1")

    async def test_disconnect_emits_error_without_scheduling_reconnect(self):
        browser = self.browser(auto_reconnect=False)
        future = asyncio.get_running_loop().create_future()
        browser._cdp_client_root = SimpleNamespace(_message_handler_task=future)
        browser.browser_profile.cdp_url = "ws://127.0.0.1:1"
        with patch.object(Browser, "_auto_reconnect", new_callable=AsyncMock) as reconnect, \
             patch.object(type(browser.event_bus), "dispatch") as dispatch:
            browser._attach_ws_drop_callback()
            future.set_result(None)
            await asyncio.sleep(0)
            reconnect.assert_not_called()
            self.assertIsNone(browser._reconnect_task)
            self.assertEqual(dispatch.call_args.args[0].error_type, "ConnectionClosed")

    async def test_default_disconnect_still_reconnects(self):
        browser = self.browser()
        future = asyncio.get_running_loop().create_future()
        browser._cdp_client_root = SimpleNamespace(_message_handler_task=future)
        browser.browser_profile.cdp_url = "ws://127.0.0.1:1"
        with patch.object(Browser, "_auto_reconnect", new_callable=AsyncMock) as reconnect:
            browser._attach_ws_drop_callback()
            future.set_result(None)
            await asyncio.sleep(0)
            await asyncio.sleep(0)
            reconnect.assert_awaited_once()

    async def test_state_capture_passes_public_screenshot_setting(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                state_request = AsyncMock(side_effect=LookupError("stop after capture request"))
                agent = SimpleNamespace(browser_session=SimpleNamespace(get_browser_state_summary=state_request),
                                        state=SimpleNamespace(n_steps=1), logger=Mock(),
                                        settings=SimpleNamespace(capture_screenshots=enabled), include_recent_events=False)
                with self.assertRaises(LookupError):
                    await Agent._prepare_context(agent)
                state_request.assert_awaited_once_with(include_screenshot=enabled, include_recent_events=False)

    async def test_disabled_capture_never_persists_even_a_supplied_screenshot(self):
        for enabled in (False, True):
            with self.subTest(enabled=enabled):
                store = AsyncMock(return_value="expected.png")
                agent = SimpleNamespace(settings=SimpleNamespace(capture_screenshots=enabled),
                                        state=SimpleNamespace(n_steps=1), logger=Mock(), history=AgentHistoryList(history=[]),
                                        screenshot_service=SimpleNamespace(store_screenshot=store))
                state = SimpleNamespace(screenshot="supplied-image", url="about:blank", title="fixture", tabs=[])
                await Agent._make_history_item(agent, None, state, [ActionResult(is_done=True, success=True)])
                self.assertEqual(store.await_count, int(enabled))
                self.assertEqual(agent.history.screenshot_paths(), ["expected.png" if enabled else None])

    def test_disabled_capture_rejects_visual_mode(self):
        with self.assertRaisesRegex(ValueError, "requires use_vision=False"):
            Agent(task="unused", use_vision=True, capture_screenshots=False)


if __name__ == "__main__":
    try:
        unittest.main()
    finally:
        temporary.cleanup()
