"""End-to-end check: does the DEPLOYED Hermes plugin fire through Hermes' own hook dispatcher?

Runs in a fresh process (same loader Hermes uses at gateway start), so a green result proves the
live plugin directory holds working code — not just that the repo copy compiles.

    python probes/verify_vibebox_plugin_hooks.py
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

FAKE_SESSION = "vibebox-verify-probe"

def main() -> int:
    from hermes_cli.plugins import discover_plugins, get_plugin_manager

    discover_plugins()
    manager = get_plugin_manager()
    loaded = sorted(getattr(manager, "plugins", {}) or {})
    print("plugins loaded:", loaded)
    if "vibebox" not in loaded:
        print("FAIL: vibebox plugin not loaded by the plugin manager")
        return 1

    hooks_ok = True
    from hermes_cli.plugins import has_hook, invoke_hook

    for hook in ("pre_llm_call", "post_tool_call"):
        present = has_hook(hook)
        print(f"hook {hook}: {'registered' if present else 'MISSING'}")
        hooks_ok &= present

    # 1) a terminal tool that touches the repository must be recorded
    invoke_hook(
        "post_tool_call",
        tool_name="terminal",
        args={"command": "git -C D:/projects/vibebox status --short"},
        session_id=FAKE_SESSION,
        result='{"output": ""}',
    )

    # 2) the next turn must carry the aftertask reminder
    results = invoke_hook("pre_llm_call", user_message="저장소 작업 이어서 해줘", session_id=FAKE_SESSION)
    context = "\n".join(
        str(r.get("context") or "") for r in results if isinstance(r, dict)
    )
    has_reminder = "⚠ VibeBox aftertask" in context
    print("reminder injected:", has_reminder)
    if context:
        print("context head:", context[:160].replace("\n", " / "))

    # clean up the probe session so it never pollutes real state
    state = Path(os.environ.get("HERMES_HOME", r"D:/HermesPrograms/hermes")) / "cache" / "vibebox" / "session_cwd.json"
    try:
        data = json.loads(state.read_text(encoding="utf-8"))
        data.get("sessions", {}).pop(FAKE_SESSION, None)
        if (data.get("last") or {}).get("cwd", "").endswith("vibebox") and FAKE_SESSION not in str(data.get("last")):
            pass
        state.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
        print("probe session cleaned from", state)
    except Exception as error:  # noqa: BLE001
        print("state cleanup skipped:", error)

    ok = hooks_ok and has_reminder
    print("RESULT:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
