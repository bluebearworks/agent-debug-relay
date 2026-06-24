# Agent Debug Relay CLI

CLI for discovering Agent Debug Relay VS Code windows and controlling debug sessions.

Install:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

Use:

```powershell
agent-debug-relay instances
agent-debug-relay profiles --workspace C:\path\to\repo
agent-debug-relay start "Launch Program" --workspace C:\path\to\repo
agent-debug-relay stop "Launch Program" --workspace C:\path\to\repo
```

The CLI talks to localhost endpoints published by running VS Code windows with the Agent Debug Relay extension installed and enabled.
