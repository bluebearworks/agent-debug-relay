# vscode-agent-debug

`vscode-agent-debug` lets local agents discover running VS Code windows, list the active workspace's launch profiles, and start a named profile through VS Code's native debug API.

Each VS Code window runs a localhost endpoint and publishes a small authenticated instance record under the system temp directory. Agents select the correct window by workspace path, read launch profiles from that window, then request a named profile launch.

## Build

```powershell
npm install
npm run build
```

## Use During Extension Development

Open this repo in VS Code and press `F5` to launch an Extension Development Host. Open a project with `.vscode/launch.json` in that host window, then run the CLI from any terminal:

```powershell
node .\bin\vscode-agent-debug.js instances --workspace C:\path\to\project
node .\bin\vscode-agent-debug.js profiles --workspace C:\path\to\project
node .\bin\vscode-agent-debug.js start "Launch Program" --workspace C:\path\to\project
```

## Agent Protocol

The default registry directory is:

```text
%TEMP%\vscode-agent-debug\instances
```

Each `*.json` record contains the VS Code window id, process id, workspace folders, active editor, focus state, endpoint host and port, and bearer token.

Endpoints:

```text
GET  /health
GET  /instance
GET  /launch-profiles
GET  /debug-sessions
POST /debug-sessions
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

## Settings

| Setting | Default | Purpose |
| --- | --- | --- |
| `agentDebug.enabled` | `true` | Starts the local endpoint in each VS Code window. |
| `agentDebug.host` | `127.0.0.1` | Binds the local endpoint. |
| `agentDebug.registryDir` | empty | Publishes instance records in a custom directory. |
| `agentDebug.notifyOnLaunch` | `true` | Shows a notification when an agent starts a profile. |

