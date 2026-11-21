# VibeBox Hermes Adapter & Integration Guide

This adapter documents how the Hermes peer agent integrates with VibeBox without modifying VibeBox Core.

## Design Principles

1. **Zero Core Modification**: Hermes interacts with VibeBox exclusively through the standard CLI commands (`bin/vibebox.mjs`) and shared skill definitions (`skills/vibebox/SKILL.md`).
2. **Semantic Authority**: Hermes interprets user intents, extracts structured candidates, and assesses task outcomes.
3. **Agent Runtime Identifier**: Use `VIBEBOX_AGENT_RUNTIME=hermes` for semantic operations.

## Role Separation Matrix

To prevent memory pollution and duplication, VibeBox and Hermes maintain strict role boundaries:

| Dimension | VibeBox (Coding Memory Middleware) | Hermes (User Agent & Coordinator) |
|---|---|---|
| **Primary Focus** | Technical rules, architecture patterns, failure avoidance, bug fixes | User persona, preferences, task review, cross-agent coordination |
| **Storage Backend** | Single global store (`~/.vibebox`) + Obsidian Vault Markdown notes | Hermes user profile (`_profile/decisions.md`), conversation logs |
| **Data Scope** | Codebase-specific & domain-specific coding patterns | User-level working style, communication habits, collaboration rules |
| **Retrieval Timing** | `pretask --task "<task>"` before repository code modifications | On conversation start, user interaction, or peer agent reviews |
| **Capture Timing** | `aftertask` with structured candidates upon task completion | Continuous learning, self-improvement review prompts |
| **Obsidian Output** | Renders into dedicated Obsidian Vault subfolder (`<vault>/VibeBox/`) | Reads or links to Obsidian notes as human-readable context |

## Automated Memory Hook (`pre_llm_call`)

Hermes supports the `pre_llm_call` plugin hook to automatically retrieve active VibeBox memory before generating plans or executing tools:

1. Import or invoke `adapters/hermes/vibebox_hermes_hook.py`:
   ```python
   from adapters.hermes.vibebox_hermes_hook import pre_llm_call_hook

   # Inside Hermes plugin hook pre_llm_call:
   def pre_llm_call(prompt, cwd=None):
       return pre_llm_call_hook(prompt, cwd=cwd)
   ```
2. The hook uses the shared VibeBox hook engine with `VIBEBOX_AGENT_RUNTIME=hermes`, applies intent gating to skip casual chat, and returns retrieved active guidance under `{"context": "..."}`.

## Manual CLI Invocation Pattern

Hermes invokes VibeBox using the bundled CLI script relative to the plugin or skill root:

```bash
# Retrieve coding guardrails & past failure patterns
node "<vibebox-plugin-root>/bin/vibebox.mjs" pretask --task "<current technical task>"

# Query strict schema before candidate generation
node "<vibebox-plugin-root>/bin/vibebox.mjs" schema --format json

# Record structured memory after technical task execution
node "<vibebox-plugin-root>/bin/vibebox.mjs" aftertask \
  --request "<user request>" \
  --summary "<action summary>" \
  --candidates '<structured-candidates-json>'
```

## Aftertask Reminder (`post_tool_call` capture nudge)

Injection alone never writes memory: `aftertask` needs agent-authored request/summary/candidates, so
the Hermes plugin cannot capture on the agent's behalf. It can only notice that a capture is missing.

- `post_tool_call` records two timestamps per session in `$HERMES_HOME/cache/vibebox/session_cwd.json`:
  `repo_touched_at` (a tool touched a path inside a repository) and `aftertask_at` (the tool call ran
  `vibebox aftertask` / `vibebox capture`).
- `pre_llm_call` appends one reminder line to the turn when `repo_touched_at > aftertask_at`. It fires
  at most once per 10 minutes per session, and any capture in that session clears it.
- The reminder follows the store language (`contextLanguage` / `outputLanguage` in `~/.vibebox/config.json`).
- It is a nudge, not a briefing: the agent still decides when the work is finished and what the capture says.

Timestamps are sub-second floats on purpose — work → capture → work inside the same wall-clock second
must still order correctly.

## Plugin Source And Deployment

`adapters/hermes/plugin/` is the single source of truth for the Hermes plugin. The live directory
(`$HERMES_HOME/plugins/vibebox`) is only a copy:

```bash
npm run sync:hermes-plugin    # copy source -> live plugin dir (backs up the previous copy)
npm run check:hermes-plugin   # exit 1 when the live copy drifts (also chained into `npm run check`)
npm run test:hermes-plugin    # python -m unittest on reminder/briefing behaviour
```

Hermes imports plugins at gateway start, so a deployed change needs `hermes gateway restart`. When a
live chat session refuses the restart, run `gateway-service/gwcycle.bat` from a one-shot scheduled task
instead of killing the turn in progress.

## Migration & Deterministic Wiki Rebuild

When moving to a new machine:
1. Restore the global brain store using `vibebox restore --from <backup-path> --confirm-replace`.
2. Set `VIBEBOX_WIKI_ROOT` to the local Obsidian Vault subfolder.
3. Regenerate all Obsidian markdown notes deterministically:
   ```bash
   node "<vibebox-plugin-root>/bin/vibebox.mjs" rebuild --wiki-only
   ```
   This rebuild runs without requiring an AI agent runtime or semantic re-interpretation.
