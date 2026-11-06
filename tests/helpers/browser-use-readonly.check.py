"""只读任务动作守卫；不启动浏览器或请求模型。"""
import importlib.util
from pathlib import Path
import unittest

entry = Path(__file__).resolve().parents[2] / "resources/testing/ui/browser-use/explore.py"
spec = importlib.util.spec_from_file_location("readonly_explore", entry)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)


class ReadonlyChecks(unittest.TestCase):
    def setUp(self):
        self.message = {"address": "https://example.invalid/app", "contract": {
            "identity": {"text": "reviewer"}, "completionTexts": ["Beta ready"],
            "controls": [
                {"action": "click", "role": "button", "name": "Detail", "ancestor": {"attributes": {"data-row": "Beta"}}},
                {"action": "input", "role": "textbox", "name": "Filter", "values": ["Beta"]},
            ]}}
        self.target = {"role": "button", "name": "Detail", "attributes": {}}
        self.beta = [{"attributes": {"data-row": "Beta"}}]

    def guard(self, data, target=None, ancestors=None, visible="reviewer Beta ready"):
        return probe.readonly_guard(self.message, data, target or self.target, ancestors or self.beta, visible)

    def test_schema_exposes_only_readonly_capabilities(self):
        tools = probe.Tools(exclude_actions=[name for name in probe.PROBE_EXCLUDED_ACTIONS if name not in ("input", "select_dropdown")])
        schema = tools.registry.create_action_model().model_json_schema()
        names = {next(iter(schema["$defs"][item["$ref"].split("/")[-1]]["properties"])) for item in schema["anyOf"]}
        self.assertEqual(names, {"navigate", "click", "input", "select_dropdown", "done"})

    def test_same_named_button_requires_declared_business_row(self):
        self.guard({"click": {"index": 1}})
        with self.assertRaisesRegex(ValueError, "undeclared-readonly-control"):
            self.guard({"click": {"index": 1}}, ancestors=[{"attributes": {"data-row": "Alpha"}}])

    def test_unknown_identity_stops_before_action(self):
        with self.assertRaisesRegex(ValueError, "identity-not-observed"):
            self.guard({"click": {"index": 1}}, visible="unknown")

    def test_filter_only_uses_declared_value_and_clear(self):
        target = {"role": "textbox", "name": "Filter", "attributes": {}}
        self.guard({"input": {"index": 1, "text": "Beta"}}, target)
        with self.assertRaisesRegex(ValueError, "undeclared-filter-value"):
            self.guard({"input": {"index": 1, "text": "Other"}}, target)
        with self.assertRaisesRegex(ValueError, "coordinate-or-append-forbidden"):
            self.guard({"input": {"index": 1, "text": "Beta", "clear": False}}, target)

    def test_coordinates_and_undeclared_write_controls_rejected(self):
        with self.assertRaisesRegex(ValueError, "coordinate-or-append-forbidden"):
            self.guard({"click": {"index": 1, "coordinate_x": 100}})
        with self.assertRaisesRegex(ValueError, "undeclared-readonly-control"):
            self.guard({"click": {"index": 1}}, {"role": "button", "name": "Delete", "attributes": {}})

    def test_navigation_respects_origin_and_project_path(self):
        self.guard({"navigate": {"url": "https://example.invalid/app/accounts"}})
        for url in ["https://example.invalid/another", "https://other.invalid/app", "https://example.invalid:444/app", "https://user:pass@example.invalid/app", "http://example.invalid/app"]:
            with self.subTest(url=url), self.assertRaisesRegex(ValueError, "outside-project-navigation"):
                self.guard({"navigate": {"url": url}})

    def test_done_requires_observed_identity_business_and_success(self):
        self.guard({"done": {"success": True}})
        for visible in ["reviewer Loading", "unknown Beta ready"]:
            with self.subTest(visible=visible), self.assertRaisesRegex(ValueError, "not-observed"):
                self.guard({"done": {"success": True}}, visible=visible)
        with self.assertRaisesRegex(ValueError, "not-observed"):
            self.guard({"done": {"success": False}})


if __name__ == "__main__":
    unittest.main()
