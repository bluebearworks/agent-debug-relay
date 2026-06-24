# Agent Debug Relay

Agent Debug Relay lets local agents discover running VS Code windows, list the active workspace's launch profiles, and start a named profile through VS Code's native debug API.

Each VS Code window runs a localhost endpoint and publishes a small authenticated instance record under the system temp directory. Agents select the correct window by workspace path, read launch profiles from that window, then request a named profile launch.

## Pieces

This repo has two pieces:

- The VS Code extension runs inside each VS Code window and publishes the local authenticated endpoint.
- The `agent-debug-relay` CLI is what agents run from a terminal to discover windows, list profiles, and control debug sessions.

Installing the VS Code extension makes the endpoint run locally in VS Code. Linking or installing the CLI makes the agent command available on `PATH`.

## Install The Extension Into VS Code

```powershell
npm install
npm run build
npx @vscode/vsce package --allow-missing-repository
code --install-extension .\agent-debug-relay-0.1.0.vsix --force
```

Reload already-open VS Code windows after installing a new VSIX. Newly opened windows load the installed extension automatically.

## Install The CLI Command

The VSIX install runs the extension inside VS Code, and `npm link` exposes the agent CLI command in terminals:

```powershell
npm link
```

For distribution, install the package globally or provide a command shim named `agent-debug-relay`.

## Protocol

Each instance record includes:

```json
{
  "extensionVersion": "0.1.0",
  "protocolVersion": 2,
  "capabilities": [
    "profiles",
    "profileLifecycleFields",
    "sessions",
    "stop",
    "restart",
    "stopPolling"
  ]
}
```

The CLI reports a reload message when a selected VS Code window is still running an older extension host protocol.

## Run Without Installing

Open this repo in VS Code and press `F5` to launch an Extension Development Host. This runs the extension from the repo without installing the VSIX into your normal VS Code profile. Open a project with `.vscode/launch.json` in that host window, then run the CLI from any terminal:

```powershell
agent-debug-relay instances --workspace C:\path\to\project
agent-debug-relay profiles --workspace C:\path\to\project
agent-debug-relay start "Launch Program" --workspace C:\path\to\project
agent-debug-relay sessions --workspace C:\path\to\project
agent-debug-relay stop "Launch Program" --workspace C:\path\to\project
```

## Agent Protocol

The default registry directory is:

```text
%TEMP%\agent-debug-relay\instances
```

Each `*.json` record contains the VS Code window id, process id, workspace folders, active editor, focus state, endpoint host and port, and bearer token.

Endpoints:

```text
GET  /health
GET  /instance
GET  /launch-profiles
GET  /debug-sessions
POST /debug-sessions
POST /debug-sessions/stop
POST /debug-sessions/restart
```

Authenticated requests use:

```text
Authorization: Bearer <token from registry record>
```

Start a profile:

```json
{
  "profileName": "Launch Program",
  "folderUri": "file:///c%3A/path/to/project"
}
```

The extension passes the named profile into `vscode.debug.startDebugging(folder, profileName, options)`, so VS Code resolves variables, saves dirty files, applies current launch configuration state, and starts the same debug session path used by the Run and Debug UI.

Profile discovery surfaces `preLaunchTask` and `postDebugTask` as top-level fields alongside the full launch profile detail. For compiled services, put builds in `preLaunchTask` when possible so an agent `start` follows the same path as a manual VS Code launch.

For services that need a restart, agents can stop the active or selected debug session, wait for termination, then start the same profile again. `restart` is available for a direct stop-and-start. `stop` and `restart` accept `--wait-ms <milliseconds>`; the default wait is 15000ms.

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `agentDebugRelay.enabled` | `true` | Starts the local endpoint in each VS Code window. |
| `agentDebugRelay.host` | `127.0.0.1` | Binds the local endpoint. |
| `agentDebugRelay.registryDir` | empty | Publishes instance records in a custom directory. |
| `agentDebugRelay.notifyOnLaunch` | `true` | Shows a notification when an agent starts a profile. |
