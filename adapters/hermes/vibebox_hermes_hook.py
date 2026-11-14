"""VibeBox Hermes Adapter - pre_llm_call hook integration.

Invokes the shared VibeBox hook engine via Node.js with runtime attribution set to 'hermes'.
"""

import json
import os
import subprocess
import sys
from pathlib import Path


def get_hook_script_path() -> Path:
    current_dir = Path(__file__).resolve().parent
    repo_root = current_dir.parent.parent
    candidates = [
        repo_root / "scripts" / "hermes-vibebox-hook.mjs",
        repo_root / "plugins" / "vibebox" / "scripts" / "hermes-vibebox-hook.mjs",
        repo_root / "scripts" / "vibebox-hook-core.mjs",
        repo_root / "plugins" / "vibebox" / "scripts" / "vibebox-hook-core.mjs",
    ]
    for c in candidates:
        if c.exists():
            return c
    return candidates[0]


def pre_llm_call_hook(user_prompt: str, cwd: str = None) -> dict:
    """Pre-invocation hook for Hermes.

    Calls the shared VibeBox hook runner with VIBEBOX_AGENT_RUNTIME=hermes.
    Returns {"context": ...} if active memory was retrieved, or empty dict if not.
    """
    if not user_prompt or not user_prompt.strip():
        return {}

    current_cwd = cwd or os.getcwd()
    hook_script = get_hook_script_path()

    if not hook_script.exists():
        return {}

    env = os.environ.copy()
    env["VIBEBOX_AGENT_RUNTIME"] = "hermes"

    payload = json.dumps({
        "hook_event_name": "UserPromptSubmit",
        "prompt": user_prompt,
        "cwd": current_cwd
    })

    try:
        proc = subprocess.run(
            ["node", str(hook_script), "UserPromptSubmit"],
            input=payload,
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=env,
            timeout=10,
        )
        if proc.returncode == 0 and proc.stdout:
            data = json.loads(proc.stdout)
            additional_context = (
                data.get("hookSpecificOutput", {}).get("additionalContext")
                or ""
            )
            if additional_context:
                return {"context": additional_context}
    except Exception:
        pass

    return {}


if __name__ == "__main__":
    test_prompt = "VibeBox 훅 동작 테스트" if len(sys.argv) < 2 else " ".join(sys.argv[1:])
    result = pre_llm_call_hook(test_prompt)
    print(json.dumps(result, ensure_ascii=False, indent=2))
