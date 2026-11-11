"""真实本地控件与 browser-use 动作适配；不使用模型或账号。"""
import asyncio
import importlib.util
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import sys
import shutil
import tempfile
import threading

entry = Path(__file__).resolve().parents[2] / "resources/testing/ui/browser-use/explore.py"
spec = importlib.util.spec_from_file_location("dropdown_explore", entry)
probe = importlib.util.module_from_spec(spec)
spec.loader.exec_module(probe)

HTML = b'''<p>fixture-reviewer</p>
<button role="combobox" aria-label="Department" onclick="document.querySelector('#options').hidden=false">Choose</button>
<div id="options" hidden><button role="option" onclick="document.querySelector('#custom').textContent='Custom Beta';this.parentNode.hidden=true">Beta</button></div>
<p id="custom">Custom empty</p>
<select aria-label="Native" onchange="document.querySelector('#native').textContent='Native '+this.options[this.selectedIndex].text"><option>Alpha</option><option>Beta</option></select>
<p id="native">Native empty</p>'''


class Page(BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.end_headers()
        self.wfile.write(HTML)

    def log_message(self, *args):
        pass


async def check(origin, directory):
    probe.configure_loopback_proxy_bypass()
    browser = probe.Browser(browser_profile=probe.BrowserProfile(launch_max_attempts=1, auto_reconnect=False,
                            user_data_dir=directory / "profile"), executable_path=sys.argv[1], headless=True,
                            keep_alive=False, enable_default_extensions=False)
    message = {"address": origin, "contract": {"identity": {"text": "fixture-reviewer"},
               "completionTexts": ["Custom Beta", "Native Beta"], "controls": [
                   {"action": "click", "attributes": {"aria-label": "Department"}},
                   {"action": "click", "name": "Beta", "attributes": {"role": "option"}},
                   {"action": "select_dropdown", "attributes": {"aria-label": "Native"}, "values": ["Beta"]}]}}
    tools = probe.exploration_tools(message)
    action_model = tools.registry.create_action_model()
    try:
        await browser.start()
        await browser.navigate_to(origin)
        for kind, name in [("click", "Department"), ("click", "Beta"), ("select_dropdown", "Native")]:
            state = await browser.get_browser_state_summary(include_screenshot=False, cached=False)
            (directory / f"{name}.txt").write_text(state.dom_state.llm_representation(), encoding="utf-8")
            targets = [(index, node) for index, node in state.dom_state.selector_map.items()
                       if node.ax_node and node.ax_node.name == name]
            assert len(targets) == 1, (name, len(targets))
            index, node = targets[0]
            data = {kind: {"index": index, **({"text": "Beta"} if kind == "select_dropdown" else {})}}
            probe.readonly_guard(message, data, probe.describe(node), [], state.dom_state.llm_representation())
            result = await tools.act(action_model.model_validate(data), browser_session=browser)
            assert not result.error, result.error
        state = await browser.get_browser_state_summary(include_screenshot=False, cached=False)
        probe.readonly_guard(message, {"done": {"success": True}}, None, [], state.dom_state.llm_representation())
    finally:
        await browser.kill()


if __name__ == "__main__":
    directory = Path(tempfile.mkdtemp(prefix="browser-use-dropdown-"))
    passed = False
    try:
        server = ThreadingHTTPServer(("127.0.0.1", 0), Page)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            asyncio.run(asyncio.wait_for(check(f"http://127.0.0.1:{server.server_port}", directory), 60))
            print("custom-clicks/native-select: passed; model calls: 0")
            passed = True
        finally:
            server.shutdown()
            server.server_close()
            thread.join()
    finally:
        if passed:
            shutil.rmtree(directory)
        else:
            print(f"preserved fixture: {directory}")
