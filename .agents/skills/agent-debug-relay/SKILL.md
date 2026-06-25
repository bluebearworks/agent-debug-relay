---
name: agent-debug-relay
description: Start, stop, restart, and inspect VS Code debug sessions through the Agent Debug Relay CLI and VS Code extension (bluebearworks.agent-debug-relay). Use this to launch a debug profile, cycle a session after a code change or rebuild, check whether a session is active, discover available launch profiles in a workspace or multi-root solution, or control VS Code debug state without touching the UI.
---

# Agent Debug Relay

Use this skill to start, stop, and inspect VS Code debug sessions from an agent.
Use the CLI as the sole source of truth. Do not scan `launch.json`, `.csproj`, `.sln`, or `launchSettings.json` files directly.

## Setup

Install the CLI:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

## Workflow

1. Find the target VS Code window.

Known workspace path:
```powershell
agent-debug-relay instances --workspace <repo-path> --json
```
Unknown path - list all windows and select an id or repo path from the output:
```powershell
agent-debug-relay instances --json
```

Use `--instance <id>` in place of `--workspace` when selecting by instance id.

2. List profiles from that window.

```powershell
agent-debug-relay profiles --workspace <repo-path> --json
agent-debug-relay profiles --instance <id> --json
```

Use exact profile names returned by `profiles`. In multi-root workspaces or multi-project .NET solutions, names can duplicate across folders/projects; add `--folder <folder-or-project>` to `start`, `stop`, or `restart` to disambiguate.

3. Check running sessions before stopping.

```powershell
agent-debug-relay sessions --workspace <repo-path> --json
```

4. Start, stop, or restart.

Named profile, no existing session:

```powershell
agent-debug-relay start "<profile name>" --workspace <repo-path> --json
```

Duplicate profile name:

```powershell
agent-debug-relay start "<profile name>" --workspace <repo-path> --folder <folder-or-project> --json
```

Rebuild needed:

```powershell
agent-debug-relay stop "<session id or name>" --workspace <repo-path> --json
agent-debug-relay start "<profile name>" --workspace <repo-path> --json
```

Prefer stopping a specific session by id or name. Use `--all` only when every debug session in the selected VS Code window should stop.

No rebuild needed:

```powershell
agent-debug-relay restart "<profile name>" --workspace <repo-path> --json
```

## Troubleshooting

Run `agent-debug-relay status --workspace <repo-path> --json`; set `AGENT_DEBUG_RELAY_REGISTRY_DIR` only when the extension uses a custom registry directory.
