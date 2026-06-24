---
name: agent-debug-relay
description: Start, stop, restart, and inspect VS Code debug sessions through the Agent Debug Relay extension and CLI. Use when an agent needs a running VS Code window to launch or manage an existing workspace debug profile.
---

# Agent Debug Relay

Use this skill when an agent needs VS Code to start or manage a debug session in an already-running VS Code window.

## Workflow

1. Make sure the `bluebearworks.agent-debug-relay` VS Code extension is installed and enabled in the target VS Code window.
2. Make sure the `agent-debug-relay` CLI is available on `PATH`. Install it with:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

3. Discover running VS Code windows:

```powershell
agent-debug-relay instances --workspace <repo-path> --json
```

Use windows with `protocolVersion` 2 or newer. If a command reports that a VS Code window is running an older protocol, reload that VS Code window so the installed extension code is active there.

4. List launch profiles from the selected window:

```powershell
agent-debug-relay profiles --workspace <repo-path> --json
```

Read `preLaunchTask` and `postDebugTask` from the returned profiles. When `preLaunchTask` is present, `start` lets VS Code run that task as part of the normal debug launch flow.

5. Start the chosen profile by exact name:

```powershell
agent-debug-relay start "<profile name>" --workspace <repo-path> --json
```

6. List running debug sessions when lifecycle control is needed:

```powershell
agent-debug-relay sessions --workspace <repo-path> --json
```

7. Stop the active or selected debug session before rebuilding:

```powershell
agent-debug-relay stop --workspace <repo-path> --json
agent-debug-relay stop "<session id or name>" --workspace <repo-path> --json
```

`stop` waits for the selected debug session to terminate. Use `--wait-ms <milliseconds>` to override the default wait.

8. Restart a profile when no rebuild step is needed between stop and start:

```powershell
agent-debug-relay restart "<profile name>" --workspace <repo-path> --json
```

For duplicate profile names in a multi-root workspace, add `--folder <workspace-folder-path-or-name>`.

## Selection Rules

Prefer `--workspace <repo-path>` for normal use. The CLI selects the running VS Code instance whose workspace folder contains that path, with the focused window winning ties.

Use `--instance <id>` when a previous discovery step selected a specific VS Code window.

## Launch Rules

Start existing named launch profiles whenever possible. Named profile launches use VS Code's `vscode.debug.startDebugging` API with the profile name, which keeps behavior aligned with launching from the Run and Debug UI.

Use the profile names returned by `profiles`; preserve spelling, spacing, and folder identity.

For compiled services that need a rebuild, use this loop:

```powershell
agent-debug-relay stop "<session id or name>" --workspace <repo-path> --json
agent-debug-relay start "<profile name>" --workspace <repo-path> --json
```

Prefer putting the build in the launch profile's `preLaunchTask`, so the `start` command follows the same path as a manual VS Code launch. Use explicit build commands between `stop` and `start` only when the project intentionally keeps that work outside the launch profile.

Use `restart` for stop-and-start only. It still lets VS Code run the profile's `preLaunchTask` during the new launch.

Use `--all` only when every debug session in the selected VS Code window should stop.

## Troubleshooting

Run:

```powershell
agent-debug-relay status --workspace <repo-path> --json
```

The default registry folder is `%TEMP%\agent-debug-relay\instances`. Set `AGENT_DEBUG_RELAY_REGISTRY_DIR` or the VS Code setting `agentDebugRelay.registryDir` when a custom location is useful.
