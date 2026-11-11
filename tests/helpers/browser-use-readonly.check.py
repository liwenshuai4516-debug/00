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

    def action_names(self, controls):
        tools = probe.exploration_tools({"contract": {"controls": controls}})
        schema = tools.registry.create_action_model().model_json_schema()
        return {next(iter(schema["$defs"][item["$ref"].split("/")[-1]]["properties"])) for item in schema["anyOf"]}

    def test_schema_and_guard_follow_declared_actions(self):
        self.assertEqual(self.action_names([{"action": "click"}]), {"navigate", "click", "done"})
        self.assertEqual(self.action_names(self.message["contract"]["controls"]), {"navigate", "click", "input", "done"})
        self.assertEqual(self.action_names([{"action": "select_dropdown"}]), {"navigate", "select_dropdown", "done"})

    def test_native_dropdown_requires_declared_control_and_value(self):
        target = {"role": "combobox", "name": "Department", "attributes": {}}
        self.message["contract"]["controls"].append({"action": "select_dropdown", "role": "combobox", "name": "Department", "values": ["Beta"]})
        self.guard({"select_dropdown": {"index": 1, "text": "Beta"}}, target)
        with self.assertRaisesRegex(ValueError, "undeclared-filter-value"):
            self.guard({"select_dropdown": {"index": 1, "text": "Other"}}, target)

    def test_custom_dropdown_uses_two_declared_clicks(self):
        self.message["contract"]["controls"] = [
            {"action": "click", "role": "combobox", "name": "Department"},
            {"action": "click", "role": "option", "name": "Beta"},
        ]
        self.guard({"click": {"index": 1}}, {"role": "combobox", "name": "Department", "attributes": {}})
        self.guard({"click": {"index": 2}}, {"role": "option", "name": "Beta", "attributes": {}})
        with self.assertRaisesRegex(ValueError, "undeclared-readonly-control"):
            self.guard({"select_dropdown": {"index": 1, "text": "Beta"}})

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
