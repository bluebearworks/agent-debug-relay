# Agent Debug Relay CLI

CLI for discovering Agent Debug Relay VS Code windows and controlling debug sessions.

Install:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

Install the agent skill:

```powershell
npx skills add bluebearworks/agent-debug-relay -g -a codex claude-code opencode -s agent-debug-relay -y --copy --full-depth
```

Use:

```powershell
agent-debug-relay instances
agent-debug-relay profiles --workspace C:\path\to\repo
agent-debug-relay start "Launch Program" --workspace C:\path\to\repo
agent-debug-relay stop "Launch Program" --workspace C:\path\to\repo
```

The CLI talks to localhost endpoints published by running VS Code windows with the Agent Debug Relay extension installed and enabled.
