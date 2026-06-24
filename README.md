# Agent Debug Relay

Agent Debug Relay lets local agents discover running VS Code windows, list workspace launch profiles, and control debug sessions through VS Code's native debug API.

## Packages

This repo is a monorepo with two publishable parts:

| Package | Purpose | Distribution |
| --- | --- | --- |
| `packages/extension` | VS Code extension that runs inside each VS Code window and publishes the local endpoint. | VS Code Marketplace / VSIX as `bluebearworks.agent-debug-relay` |
| `packages/cli` | Terminal command agents use to discover windows, list profiles, and control debug sessions. | npm as `@bluebearworks/agent-debug-relay` |

The CLI does not start or control VS Code by itself. It talks to endpoints published by running VS Code windows with the extension installed and enabled.

## Install

Install the VS Code extension:

```powershell
code --install-extension bluebearworks.agent-debug-relay
```

Install the CLI:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

Reload already-open VS Code windows after installing or upgrading the extension.

## Use

```powershell
agent-debug-relay instances
agent-debug-relay profiles --workspace C:\path\to\repo
agent-debug-relay start "Launch Program" --workspace C:\path\to\repo
agent-debug-relay sessions --workspace C:\path\to\repo
agent-debug-relay stop "Launch Program" --workspace C:\path\to\repo
```

## Development

Install dependencies:

```powershell
npm install
```

Build all workspaces:

```powershell
npm run build
```

Link the CLI locally:

```powershell
npm link -w packages/cli
```

Package the VS Code extension:

```powershell
npm run package:extension
```

Install the packaged VSIX:

```powershell
code --install-extension .\packages\extension\agent-debug-relay-0.1.0.vsix --force
```

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

The default registry folder is:

```text
%TEMP%\agent-debug-relay\instances
```

Set `AGENT_DEBUG_RELAY_REGISTRY_DIR` for the CLI or `agentDebugRelay.registryDir` in VS Code when a custom location is useful.

## Debug Lifecycle

Profile discovery surfaces `preLaunchTask` and `postDebugTask` as top-level fields alongside the full launch profile detail. For compiled services, put builds in `preLaunchTask` when possible so an agent `start` follows the same path as a manual VS Code launch.

For services that need a restart, agents can stop the active or selected debug session, wait for termination, then start the same profile again. `restart` is available for direct stop-and-start flows. `stop` and `restart` accept `--wait-ms <milliseconds>`; the default wait is 15000ms.
