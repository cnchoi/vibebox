"""VibeBox memory injection for Hermes (``pre_llm_call`` + session cwd/aftertask tracking).

Hermes fires ``pre_llm_call`` once per user turn, before the tool loop. This plugin asks
the VibeBox hook engine for the active project briefing and returns ``{"context": ...}``,
which Hermes appends to the current turn's user message.

The ``pre_llm_call`` payload carries no ``cwd``, so gateway sessions (Feishu, Slack,
Telegram, Discord, cron) would otherwise always query the gateway's own directory and see
only global memory. This plugin therefore also listens on ``post_tool_call``, derives the
repository root from the paths a tool touched, and remembers it per session — later
turns and later sessions then query that repository instead of the gateway cwd.

The same ``post_tool_call`` listener also watches for the capture step: repository work
in a session that never ran ``vibebox aftertask`` gets a one-line reminder appended to the
next turn. The reminder only nudges; the agent stays the semantic author of the capture
(``aftertask`` needs agent-written request/summary/candidates, so the plugin cannot and
must not run it on the agent's behalf).

All retrieval and gating live in the shared engine (``scripts/vibebox-hook-core.mjs``)
so Hermes, Claude, Codex and Antigravity cannot drift apart. This file is only the
thin per-runtime entrypoint: it sets ``VIBEBOX_AGENT_RUNTIME=hermes`` (via the Python
adapter) and converts the adapter's result into the plugin-hook return shape.

Environment overrides:
- ``VIBEBOX_REPO_ROOT``  checkout of the VibeBox engine (default ``D:/projects/vibebox``)
- ``VIBEBOX_CWD_STATE``  session→cwd state file (default ``$HERMES_HOME/cache/vibebox/session_cwd.json``)
"""

from __future__ import annotations

import json
import logging
import os
import re
import sys
import time
from pathlib import Path

logger = logging.getLogger(__name__)

DEFAULT_REPO_ROOT = Path("D:/projects/vibebox")
_MIN_PROMPT_CHARS = 2

_STATE_TTL_SECONDS = 30 * 24 * 3600
_MAX_SESSIONS = 200

# Remind about a missing capture at most once per window; repeated turns in the same
# session must not turn the briefing into noise.
_AFTERTASK_REMINDER_COOLDOWN_SECONDS = 10 * 60

# A directory counts as a project root when one of these exists inside it.
_REPO_MARKERS = (".git", ".vibebox", "package.json", "pyproject.toml", "go.mod", "Cargo.toml")
_MAX_WALK_UP = 8
_MAX_PATH_CANDIDATES = 6

_PATH_START = re.compile(r"^(?:[A-Za-z]:[\\/]|/|~[\\/])")
_WIN_TOKEN = re.compile(r"[A-Za-z]:[\\/][^\s\"'|&;<>()]+")
_POSIX_TOKEN = re.compile(r"(?<![\w.-])/(?:home|mnt|Users|tmp|opt|srv|workspace)/[^\s\"'|&;<>()]+")

# ``vibebox aftertask`` / ``node .../vibebox.mjs aftertask`` / ``vibebox capture``.
_AFTERTASK_RE = re.compile(r"vibebox(?:\.mjs)?[\"']?[\s]+(?:aftertask|capture)\b", re.IGNORECASE)

# Never treat Hermes' own tree or OS/AppData paths as the project being worked on.
_SKIP_MARKERS = (
    "\\appdata\\",
    "/appdata/",
    "\\windows\\",
    "/windows/",
    "\\hermesprograms\\",
    "/hermesprograms/",
)

_adapter = None


# ---------------------------------------------------------------- state (session → cwd)


def _state_path() -> Path:
    override = os.environ.get("VIBEBOX_CWD_STATE")
    if override:
        return Path(override)
    home = os.environ.get("HERMES_HOME")
    base = Path(home) if home else Path.home() / ".hermes"
    return base / "cache" / "vibebox" / "session_cwd.json"


def _load_state() -> dict:
    try:
        data = json.loads(_state_path().read_text(encoding="utf-8"))
        if isinstance(data, dict):
            data.setdefault("sessions", {})
            data.setdefault("last", {})
            return data
    except Exception:
        pass
    return {"sessions": {}, "last": {}}


def _save_state(state: dict) -> None:
    path = _state_path()
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(".tmp")
        tmp.write_text(json.dumps(state, ensure_ascii=False), encoding="utf-8")
        os.replace(tmp, path)
    except Exception as error:
        logger.debug("vibebox: cwd state write failed: %s", error)


def _prune_sessions(state: dict, now: int) -> dict:
    sessions = {
        key: value
        for key, value in (state.get("sessions") or {}).items()
        if isinstance(value, dict) and now - float(value.get("updated_at", 0)) < _STATE_TTL_SECONDS
    }
    if len(sessions) > _MAX_SESSIONS:
        newest = sorted(sessions.items(), key=lambda kv: kv[1].get("updated_at", 0), reverse=True)
        sessions = dict(newest[:_MAX_SESSIONS])
    return sessions


def _update_session(session_id, **fields) -> None:
    """Merge ``fields`` into the session entry (never clobbering tracked timestamps)."""
    if not session_id:
        return
    now = time.time()
    state = _load_state()
    sessions = _prune_sessions(state, now)
    entry = dict(sessions.get(str(session_id)) or {})
    entry.update(fields)
    entry["updated_at"] = now
    sessions[str(session_id)] = entry
    state["sessions"] = sessions
    if isinstance(entry.get("cwd"), str):
        state["last"] = {"cwd": entry["cwd"], "updated_at": now}
    _save_state(state)


def _session_entry(session_id) -> dict:
    if not session_id:
        return {}
    now = time.time()
    entry = _load_state()["sessions"].get(str(session_id))
    if not isinstance(entry, dict):
        return {}
    if now - float(entry.get("updated_at", 0)) >= _STATE_TTL_SECONDS:
        return {}
    return entry


def _record_cwd(session_id, cwd: str) -> None:
    """Remember the repository this session is working in."""
    _update_session(session_id, cwd=cwd, repo_touched_at=time.time())


def _remembered_cwd(session_id):
    now = time.time()

    def usable(entry) -> bool:
        if not isinstance(entry, dict):
            return False
        if now - float(entry.get("updated_at", 0)) >= _STATE_TTL_SECONDS:
            return False
        cwd = entry.get("cwd")
        return isinstance(cwd, str) and Path(cwd).is_dir()

    entry = _session_entry(session_id)
    if usable(entry):
        return entry["cwd"]

    # A new session (or a compression-rotated id) inherits the most recent repo:
    # that is the "where was I working?" behaviour expected from a chat app.
    last = _load_state().get("last")
    if usable(last):
        return last["cwd"]
    return None


# -------------------------------------------------- aftertask reminder (capture nudge)


def _store_language() -> str:
    """Language of the language-specific reminder, taken from the VibeBox store."""
    override = os.environ.get("VIBEBOX_HOME")
    base = Path(override) if override else Path.home() / ".vibebox"
    try:
        config = json.loads((base / "config.json").read_text(encoding="utf-8"))
    except Exception:
        return "en"
    for key in ("contextLanguage", "outputLanguage", "memoryLanguage", "locale"):
        value = config.get(key)
        if isinstance(value, str) and value.strip():
            return value.strip().lower()
    return "en"


def _aftertask_reminder(repo: str) -> str:
    repo = repo or "(unknown repository)"
    if _store_language().startswith("ko"):
        return (
            f"⚠ VibeBox aftertask 미실행 — 이 세션에서 `{repo}` 코드 작업을 했지만 기록이 없습니다.\n"
            "이번 턴이 그 작업의 끝이라면 턴을 닫기 전에 실행하세요(요청·요약·후보는 직접 작성):\n"
            '  VIBEBOX_AGENT_RUNTIME=hermes vibebox aftertask --request "<사용자 요청>" '
            '--summary "<한 일>" --candidates-file <json>\n'
            "재사용할 기억이 없으면 --candidates 에 no_reusable_memory_candidate 항목을 넣어 호출하세요."
        )
    return (
        f"⚠ VibeBox aftertask not run — this session did repository work in `{repo}` "
        "without capturing it.\n"
        "If this turn ends that work, capture it before ending the turn "
        "(author the request, summary and candidates yourself):\n"
        '  VIBEBOX_AGENT_RUNTIME=hermes vibebox aftertask --request "<user request>" '
        '--summary "<what you did>" --candidates-file <json>\n'
        "When nothing reusable was learned, submit a no_reusable_memory_candidate item via --candidates."
    )


def _claim_aftertask_reminder(session_id, cwd):
    """Return the reminder text once per cooldown window, else ``None``."""
    entry = _session_entry(session_id)
    touched = float(entry.get("repo_touched_at") or 0)
    if not touched:
        return None
    if float(entry.get("aftertask_at") or 0) >= touched:
        return None
    now = time.time()
    if now - float(entry.get("warned_at") or 0) < _AFTERTASK_REMINDER_COOLDOWN_SECONDS:
        return None
    _update_session(session_id, warned_at=now)
    return _aftertask_reminder(str(entry.get("cwd") or cwd or ""))


# ------------------------------------------------------ repo detection from tool args


def _iter_strings(value, depth: int = 0):
    if depth > 4:
        return
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for item in value.values():
            yield from _iter_strings(item, depth + 1)
    elif isinstance(value, (list, tuple)):
        for item in value:
            yield from _iter_strings(item, depth + 1)


def _path_candidates(payload):
    """Yield plausible filesystem paths found anywhere in a tool's arguments."""
    seen = set()
    emitted = 0
    for raw in _iter_strings(payload):
        text = raw.strip().strip("\"'")
        if not text:
            continue
        tokens = [text] if _PATH_START.match(text) else _WIN_TOKEN.findall(text) + _POSIX_TOKEN.findall(text)
        for token in tokens:
            token = token.rstrip(".,;:")
            lowered = token.lower()
            if any(marker in lowered for marker in _SKIP_MARKERS):
                continue
            if token in seen:
                continue
            seen.add(token)
            yield token
            emitted += 1
            if emitted >= _MAX_PATH_CANDIDATES:
                return


def _repo_root_for(path: Path):
    try:
        current = path if path.is_dir() else path.parent
    except OSError:
        return None
    for _ in range(_MAX_WALK_UP):
        for marker in _REPO_MARKERS:
            try:
                if (current / marker).exists():
                    return current
            except OSError:
                break
        if current.parent == current:
            break
        current = current.parent
    return None


def _repo_root_from_args(args):
    for token in _path_candidates(args):
        try:
            candidate = Path(os.path.expanduser(token))
            if not candidate.exists():
                continue
        except Exception:
            continue
        root = _repo_root_for(candidate)
        if root is not None:
            return str(root)
    return None


def _ran_aftertask(args) -> bool:
    """True when this tool call itself ran a VibeBox capture command."""
    for raw in _iter_strings(args):
        if _AFTERTASK_RE.search(raw):
            return True
    return False


# ------------------------------------------------------------------------ adapter glue


def _repo_root() -> Path:
    override = os.environ.get("VIBEBOX_REPO_ROOT")
    return Path(override) if override else DEFAULT_REPO_ROOT


def _load_adapter():
    """Import ``adapters/hermes/vibebox_hermes_hook.py`` once and cache it."""
    global _adapter
    if _adapter is not None:
        return _adapter

    adapter_dir = _repo_root() / "adapters" / "hermes"
    if not adapter_dir.is_dir():
        raise FileNotFoundError(f"VibeBox adapter directory not found: {adapter_dir}")
    if str(adapter_dir) not in sys.path:
        sys.path.insert(0, str(adapter_dir))

    from vibebox_hermes_hook import pre_llm_call_hook  # imported lazily on purpose

    _adapter = pre_llm_call_hook
    return _adapter


def _prompt_text(user_message) -> str:
    """Flatten the hook's ``user_message`` (str, or multimodal content parts)."""
    if isinstance(user_message, str):
        return user_message
    if isinstance(user_message, list):
        parts = []
        for part in user_message:
            if isinstance(part, dict):
                text = part.get("text")
                if isinstance(text, str) and text.strip():
                    parts.append(text)
        return "\n".join(parts)
    return ""


def register(ctx):
    def vibebox_memory(user_message=None, **kwargs):
        text = _prompt_text(user_message).strip()
        if len(text) < _MIN_PROMPT_CHARS:
            return None

        session_id = kwargs.get("session_id")
        cwd = _remembered_cwd(session_id) or os.getcwd()
        pieces = []

        try:
            hook = _load_adapter()
            result = hook(text, cwd=cwd)
            if isinstance(result, dict) and result.get("context"):
                pieces.append(result["context"])
        except Exception as error:  # never break a turn because memory failed
            logger.warning("vibebox: adapter call failed: %s", error)

        try:
            reminder = _claim_aftertask_reminder(session_id, cwd)
            if reminder:
                pieces.append(reminder)
        except Exception as error:
            logger.debug("vibebox: aftertask reminder failed: %s", error)

        if pieces:
            return {"context": "\n\n".join(pieces)}
        return None

    ctx.register_hook("pre_llm_call", vibebox_memory)

    def vibebox_track_cwd(tool_name=None, args=None, **kwargs):
        """Remember the repository a tool touched, and whether a capture ran."""
        del tool_name
        session_id = kwargs.get("session_id")
        payload = args if isinstance(args, (dict, list)) else {}
        try:
            root = _repo_root_from_args(payload)
            if root:
                _record_cwd(session_id, root)
        except Exception as error:
            logger.debug("vibebox: cwd tracking failed: %s", error)
        try:
            if _ran_aftertask(payload):
                _update_session(session_id, aftertask_at=time.time(), warned_at=0)
        except Exception as error:
            logger.debug("vibebox: aftertask tracking failed: %s", error)
        return None

    ctx.register_hook("post_tool_call", vibebox_track_cwd)
