"""离线核对探索提示词的随包路径、动态读取及失败收尾，不启动浏览器或请求模型。"""
from contextlib import chdir
import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch


class PromptChecks(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory(prefix="browser-use-prompt-")
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        runtime = self.root / "resources/testing/ui"
        (runtime / "browser-use").mkdir(parents=True)
        source = Path(__file__).resolve().parents[2] / "resources/testing/ui"
        entry = runtime / "browser-use/explore.py"
        shutil.copyfile(source / "browser-use/explore.py", entry)
        (runtime / "prompt").mkdir()
        self.prompt = runtime / "prompt/exploration-control.md"
        shutil.copyfile(source / "prompt/exploration-control.md", self.prompt)
        spec = importlib.util.spec_from_file_location("packaged_exploration", entry)
        self.probe = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(self.probe)
        self.probe.task_id = "offline-prompt"
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.task_count = 0

    async def explore(self, rejected_action=False):
        self.task_count += 1
        output = self.root / f"task-{self.task_count}"
        output.mkdir()
        message = {"workflow": "browser-use-playwright", "output": str(output),
                   "url": "https://example.invalid/app/list", "goal": "仅观察合同列表，排除提交与删除",
                   "chromium": "unused", "storageState": {}, "contract": {
                       "mode": "candidate", "expected": [{"id": "list", "text": "合同列表"}],
                       "controls": [{"action": "click"}],
                       "budget": {"maxSteps": 3, "timeoutMs": 2000}}}
        frozen = copy.deepcopy(message)
        browser = SimpleNamespace(start=AsyncMock(), kill=AsyncMock(),
                                  event_bus=SimpleNamespace(on=Mock(), event_history={}))
        history = SimpleNamespace(is_done=lambda: True, is_successful=lambda: True)
        agent = SimpleNamespace(run=AsyncMock(return_value=history))
        if rejected_action:
            async def invoke_undeclared_action(**kwargs):
                action = SimpleNamespace(model_dump=lambda **kwargs: {"input": {"index": 1, "text": "private-input-value"}},
                                         get_index=lambda: 1)
                target = SimpleNamespace(node_name="INPUT", ax_node=SimpleNamespace(role="textbox"))
                state = SimpleNamespace(dom_state=SimpleNamespace(selector_map={1: target}))
                await factory.call_args.kwargs["register_new_step_callback"](state, SimpleNamespace(action=[action]), 1)
            agent.run.side_effect = invoke_undeclared_action
        records = []
        read_fd, write_fd = os.pipe()
        try:
            with os.fdopen(read_fd) as stream, chdir(self.workspace), \
                    patch.object(self.probe, "Browser", return_value=browser), \
                    patch.object(self.probe, "Agent", return_value=agent) as factory, \
                    patch.object(self.probe, "configure_loopback_proxy_bypass"), \
                    patch.object(self.probe.psutil, "Process", return_value=SimpleNamespace(children=lambda **kwargs: [])), \
                    patch.object(self.probe.psutil, "wait_procs", return_value=([], [])), \
                    patch.object(self.probe.sys, "stdin", stream), \
                    patch.object(self.probe, "emit", side_effect=lambda kind, **values: records.append({"type": kind, **values})):
                result = await self.probe.run(message)
        finally:
            os.close(write_fd)
        self.assertEqual(message, frozen, "提示词组装不能改写冻结的任务参数")
        browser.kill.assert_awaited_once()
        self.assertTrue(records[-1]["cleanupConfirmed"])
        self.assertEqual(records[-1]["modelCalls"], 0)
        return result, factory, message

    async def test_packaged_prompt_reaches_agent_and_updates_on_next_task(self):
        original = self.prompt.read_text(encoding="utf-8").strip()
        result, factory, message = await self.explore()
        self.assertEqual(result["status"], "completed")
        factory.assert_called_once()
        task = factory.call_args.kwargs["task"]
        self.assertTrue(task.endswith(original + "\n"))
        self.assertIn(message["goal"], task)
        self.assertIn(json.dumps(message["contract"], ensure_ascii=False), task)
        updated = "第二次任务优先探索查询功能，完成后继续自由探索。"
        self.prompt.write_text(updated, encoding="utf-8")
        result, factory, _ = await self.explore()
        self.assertEqual(result["status"], "completed")
        self.assertTrue(factory.call_args.kwargs["task"].endswith(updated + "\n"))
        self.assertNotIn(original, factory.call_args.kwargs["task"])

    async def test_missing_prompt_stops_before_agent_without_fallback(self):
        # 旧位置残留也不能覆盖新 prompt 目录的缺失错误。
        (self.prompt.parent.parent / "exploration-control.md").write_text("旧路径提示词", encoding="utf-8")
        self.prompt.unlink()
        result, factory, _ = await self.explore()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "FileNotFoundError")
        factory.assert_not_called()

    async def test_empty_prompt_stops_before_agent_without_fallback(self):
        self.prompt.write_text(" \n\t", encoding="utf-8")
        result, factory, _ = await self.explore()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["reason"], "ValueError")
        factory.assert_not_called()

    async def test_undeclared_action_returns_safe_target_and_stage(self):
        result, _, _ = await self.explore(rejected_action=True)
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["actionDiagnostic"], {"action": "input", "phase": "guard",
                         "target": {"index": 1, "tag": "INPUT", "role": "textbox"}})
        self.assertNotIn("private-input-value", json.dumps(result))


if __name__ == "__main__":
    unittest.main()
