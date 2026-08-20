---
name: agent-debug-relay
description: Control VS Code debug sessions and integrated terminals through the Agent Debug Relay CLI and VS Code extension (bluebearworks.agent-debug-relay). Use this to launch or inspect a debugger, manage breakpoints, evaluate expressions, run commands in visible VS Code terminals, send terminal input, read captured output, or stop terminal processes without touching the UI.
---

# Agent Debug Relay

Use this skill to control and inspect VS Code debug sessions and integrated terminals from an agent.
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

5. Interact with a running debugger.

```powershell
agent-debug-relay breakpoint add <file>:<line> --workspace <repo-path> --json
agent-debug-relay breakpoint add <file>:<line> --condition "<expression>" --workspace <repo-path> --json
agent-debug-relay pause --workspace <repo-path> --json
agent-debug-relay stack --workspace <repo-path> --json
agent-debug-relay locals --workspace <repo-path> --json
agent-debug-relay variables <variablesReference> --workspace <repo-path> --json
agent-debug-relay eval "<expression>" --workspace <repo-path> --json
agent-debug-relay continue --workspace <repo-path> --json
agent-debug-relay output --tail 50 --workspace <repo-path> --json
```

Use `threads`, `--thread-id`, `--frame-id`, and `--session` when the active stopped context is not the intended target. Treat `eval` as potentially side-effectful because the debug adapter evaluates the supplied expression in the target process.

6. Run and manage integrated-terminal commands.

```powershell
agent-debug-relay terminal list --workspace <repo-path> --json
agent-debug-relay terminal run "npm start" --name "dev server" --workspace <repo-path> --json
agent-debug-relay terminal output <terminal-id> --tail 50 --workspace <repo-path> --json
agent-debug-relay terminal input "r" --terminal <terminal-id> --no-enter --workspace <repo-path> --json
agent-debug-relay terminal stop <terminal-id> --workspace <repo-path> --json
```

`terminal run` creates a visible VS Code terminal when `--terminal`, `--terminal-id`, and `--terminal-name` are omitted. Reuse the returned terminal id for output, input, and stop. Shell integration enables captured output and exit state; check `outputCapture` in the run response. Terminal commands execute in the user's shell and can have side effects.

## Troubleshooting

Run `agent-debug-relay status --workspace <repo-path> --json`; set `AGENT_DEBUG_RELAY_REGISTRY_DIR` only when the extension uses a custom registry directory.
