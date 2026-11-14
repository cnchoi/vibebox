# VibeBox Google Antigravity Adapter

This adapter documents how Google Antigravity (AGY) integrates with VibeBox memory middleware.

## Overview

Google Antigravity utilizes VibeBox as a local-first active pattern graph and blackbox memory middleware:
- **Zero Core Modification**: Uses standard VibeBox Core CLI (`bin/vibebox.mjs`) and shared skill definitions (`skills/vibebox/SKILL.md`).
- **Semantic Authority**: Antigravity is the semantic authority for task interpretation and structured candidate creation; Core validates, indexes, dedupes, and renders wiki pages.
- **Agent Runtime Identifier**: Set `VIBEBOX_AGENT_RUNTIME=antigravity` when running semantic operations or adapter commands.

## Skill Installation

### Global User Skill (Recommended)
Place the VibeBox skill in your Antigravity user skills directory:

```text
~/.gemini/antigravity/skills/vibebox/SKILL.md
```

Copy the contents from `skills/vibebox/` into this directory:
- `SKILL.md`
- `references/COMMANDS.md`
- `references/WORKFLOW.md`
- `references/MEMORY_POLICY.md`

### Workspace Skill
In a project workspace, Antigravity also discovers skills located at:

```text
.agents/skills/vibebox/SKILL.md
```

Or via the marketplace catalog manifest at `.agents/plugins/marketplace.json`.

## Lifecycle Hooks Integration (Auto-Intervention & After-Task)

Antigravity 2.0 / IDE natively supports automated lifecycle hooks via `hooks.json`.
Instead of manually typing `pretask` and `aftertask` commands, you can enable fully automated memory retrieval and checkpoints across the IDE, CLI, and Slack bridges.

### 1. Global Installation (Recommended: 1-Command Setup)
Run the automated setup command to configure global hooks with the resolved script path:

```bash
vibebox setup-antigravity
```

This safely creates or merges hooks into `~/.gemini/config/hooks.json` with the absolute path to `antigravity-vibebox-hook.mjs` and backs up any existing configuration:

```json
{
  "vibebox": {
    "PreInvocation": [
      {
        "type": "command",
        "command": "node \"<vibebox-path>/scripts/antigravity-vibebox-hook.mjs\" PreInvocation",
        "timeout": 30
      }
    ],
    "Stop": [
      {
        "type": "command",
        "command": "node \"<vibebox-path>/scripts/antigravity-vibebox-hook.mjs\" Stop",
        "timeout": 30
      }
    ]
  }
}
```

You can also specify a custom hooks location with `--hooks-path <path>`.

### 2. Native Plugin & Workspace Project Hooks
- When installed as an Antigravity plugin (`plugins/vibebox`), `hooks.json` at the plugin root is automatically discovered and executes using relative paths:
  ```json
  {
    "vibebox": {
      "PreInvocation": [
        {
          "type": "command",
          "command": "node ./scripts/antigravity-vibebox-hook.mjs PreInvocation",
          "timeout": 30
        }
      ],
      "Stop": [
        {
          "type": "command",
          "command": "node ./scripts/antigravity-vibebox-hook.mjs Stop",
          "timeout": 30
        }
      ]
    }
  }
  ```
- For workspace-specific hook execution, place `hooks.json` at `.agents/hooks.json`.

### 3. How It Operates
- **PreInvocation Hook**: Automatically intercepts actionable development tasks (gating out casual chat/greetings), runs `pretask`, and injects relevant memory rules into the model context before planning or code generation.
- **Stop Hook**: Triggers an aftertask checkpoint prompt with `VIBEBOX_AGENT_RUNTIME=antigravity` guidance when significant work has occurred.

## Manual Workflow Integration

1. **Pre-Task Auto-Intervention**:
   Before initiating meaningful code changes, invoke with agent runtime attribution:
   ```bash
   VIBEBOX_AGENT_RUNTIME=antigravity node "<vibebox-plugin-root>/bin/vibebox.mjs" pretask --task "<current user request>"
   # Or globally linked:
   VIBEBOX_AGENT_RUNTIME=antigravity vibebox pretask --task "<current user request>"
   ```
   Apply the retrieved active memory rules and failure avoidance guidance as context for execution.

2. **Strict Schema Check**:
   Before creating structured candidate JSON:
   ```bash
   node "<vibebox-plugin-root>/bin/vibebox.mjs" schema --format json
   ```
   Use only contract enums and the configured user language display fields.

3. **After-Task Memory Capture**:
   Upon task completion, capture with runtime attribution:
   ```bash
   VIBEBOX_AGENT_RUNTIME=antigravity node "<vibebox-plugin-root>/bin/vibebox.mjs" aftertask --request "<user request>" --summary "<summary>" --candidates "<candidates json>"
   ```
   VibeBox automatically records `agent: "antigravity"` in the generated Obsidian markdown note frontmatter.

## Obsidian Vault Direct Integration

Set your Obsidian vault subfolder so wiki notes are rendered directly for human review:

```bash
# In shell environment or launcher:
export VIBEBOX_WIKI_ROOT="/path/to/your-vault/VibeBox"
```

Safety guards automatically prevent vault root pollution (detecting `.obsidian/`) and protect unmanaged markdown notes.

## Role Separation: VibeBox vs. Hermes

| Dimension | VibeBox Responsibility | Hermes Responsibility |
|---|---|---|
| **Primary Domain** | Coding patterns, technical decisions, failure avoidance, bug patterns | User persona, personal work habits, coordination |
| **Storage Engine** | Single global store `~/.vibebox` + Obsidian Vault (`<vault>/VibeBox/`) | Hermes memory profile (`_profile/decisions.md`) |
| **Scope** | Project-level & domain-level coding memory | Cross-session user preferences & cross-agent coordination |
| **Update Lifecycle** | Automatic capture via `aftertask`, deterministic rebuild via `rebuild --wiki-only` | Iterative reflection, self-improvement reviews |
