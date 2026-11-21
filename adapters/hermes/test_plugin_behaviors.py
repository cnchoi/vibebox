"""Behaviour tests for the Hermes VibeBox plugin (stdlib unittest, no dependencies).

Run from the repository root:

    python -m unittest discover -s adapters/hermes -p "test_*.py" -v

Covers the injected-briefing path and the aftertask reminder path:
repository work without a capture must produce one reminder per cooldown window, and a
capture command in the same session must clear it.
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from pathlib import Path

PLUGIN_PATH = Path(__file__).resolve().parent / "plugin" / "__init__.py"


class _Ctx:
    """Minimal stand-in for the Hermes plugin context."""

    def __init__(self) -> None:
        self.hooks: dict[str, object] = {}

    def register_hook(self, name: str, fn) -> None:
        self.hooks[name] = fn


def _load_plugin():
    spec = importlib.util.spec_from_file_location("vibebox_hermes_plugin_under_test", PLUGIN_PATH)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


class PluginBehaviourTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.root = Path(tempfile.mkdtemp(prefix="vibebox-plugin-test-", dir="D:/projects"))
        cls.repo = cls.root / "sample-repo"
        (cls.repo / ".git").mkdir(parents=True)
        (cls.repo / "package.json").write_text("{}", encoding="utf-8")

    @classmethod
    def tearDownClass(cls) -> None:
        shutil.rmtree(cls.root, ignore_errors=True)

    def setUp(self) -> None:
        self.state_file = self.root / f"state-{self._testMethodName}.json"
        self.state_file.unlink(missing_ok=True)
        self.home = self.root / f"home-{self._testMethodName}"
        self.home.mkdir(parents=True, exist_ok=True)
        self._write_store_language("ko-KR")
        self._old_env = {
            "VIBEBOX_CWD_STATE": os.environ.get("VIBEBOX_CWD_STATE"),
            "VIBEBOX_HOME": os.environ.get("VIBEBOX_HOME"),
        }
        os.environ["VIBEBOX_CWD_STATE"] = str(self.state_file)
        os.environ["VIBEBOX_HOME"] = str(self.home)
        self.plugin, self.ctx = self._fresh_plugin()

    def tearDown(self) -> None:
        for key, value in self._old_env.items():
            if value is None:
                os.environ.pop(key, None)
            else:
                os.environ[key] = value

    # ------------------------------------------------------------------ helpers

    def _write_store_language(self, language: str) -> None:
        (self.home / "config.json").write_text(
            json.dumps({"contextLanguage": language, "outputLanguage": language}),
            encoding="utf-8",
        )

    def _fresh_plugin(self):
        plugin = _load_plugin()
        plugin._adapter = lambda text, cwd=None: {"context": f"BRIEF|{text}|cwd={cwd}"}
        ctx = _Ctx()
        plugin.register(ctx)
        return plugin, ctx

    def _turn(self, prompt: str = "implement the feature", session_id: str = "sess-1") -> str:
        result = self.ctx.hooks["pre_llm_call"](user_message=prompt, session_id=session_id)
        return "" if not result else result.get("context", "")

    def _tool(self, args: dict, session_id: str = "sess-1") -> None:
        self.ctx.hooks["post_tool_call"](tool_name="terminal", args=args, session_id=session_id)

    # -------------------------------------------------------------------- tests

    def test_briefing_only_before_any_repository_work(self) -> None:
        context = self._turn()
        self.assertIn("BRIEF", context)
        self.assertNotIn("⚠", context)

    def test_repository_work_without_capture_adds_one_reminder(self) -> None:
        self._tool({"command": f"ls {self.repo}"})
        first = self._turn()
        self.assertIn("⚠", first)
        self.assertIn("aftertask", first)
        self.assertIn(str(self.repo), first)

        # Cooldown: the very next turn must not repeat the reminder.
        second = self._turn("continue")
        self.assertIn("BRIEF", second)
        self.assertNotIn("⚠", second)

    def test_capture_command_clears_the_reminder(self) -> None:
        self._tool({"command": f"ls {self.repo}"})
        self._tool(
            {
                "command": (
                    'VIBEBOX_AGENT_RUNTIME=hermes node "D:/projects/vibebox/bin/vibebox.mjs" '
                    'aftertask --request "x" --summary "y" --candidates-file c.json'
                )
            }
        )
        context = self._turn()
        self.assertIn("BRIEF", context)
        self.assertNotIn("⚠", context)

    def test_repository_work_after_a_capture_warns_again(self) -> None:
        self._tool({"command": f"ls {self.repo}"})
        self._tool({"command": "vibebox aftertask --request x --summary y --candidates z"})
        self.assertNotIn("⚠", self._turn())
        self._tool({"command": f"cat {self.repo}/package.json"})
        self.assertIn("⚠", self._turn("more work"))

    def test_reminder_survives_a_briefing_failure(self) -> None:
        self._tool({"command": f"ls {self.repo}"})

        def boom(text, cwd=None):
            raise RuntimeError("engine unavailable")

        self.plugin._adapter = boom
        context = self._turn()
        self.assertIn("⚠", context)
        self.assertNotIn("BRIEF", context)

    def test_sessions_do_not_share_capture_state(self) -> None:
        self._tool({"command": f"ls {self.repo}"}, session_id="sess-a")
        self._tool({"command": "vibebox aftertask --request x --summary y --candidates z"}, session_id="sess-a")
        self.assertNotIn("⚠", self._turn(session_id="sess-a"))

        self._tool({"command": f"ls {self.repo}"}, session_id="sess-b")
        self.assertIn("⚠", self._turn(session_id="sess-b"))
        self.assertNotIn("⚠", self._turn(session_id="sess-a"))

    def test_reminder_uses_the_store_language(self) -> None:
        self._write_store_language("en-US")
        self.plugin, self.ctx = self._fresh_plugin()
        self._tool({"command": f"ls {self.repo}"})
        context = self._turn()
        self.assertIn("aftertask not run", context)


if __name__ == "__main__":
    unittest.main()
