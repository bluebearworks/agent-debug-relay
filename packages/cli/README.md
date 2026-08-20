# Agent Debug Relay CLI

CLI for discovering Agent Debug Relay VS Code windows and controlling and inspecting debug sessions.

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
agent-debug-relay breakpoint add .\src\Program.cs:24 --workspace C:\path\to\repo
agent-debug-relay stack --workspace C:\path\to\repo --json
agent-debug-relay locals --workspace C:\path\to\repo --json
agent-debug-relay eval "customer.Total" --workspace C:\path\to\repo --json
agent-debug-relay output --tail 50 --workspace C:\path\to\repo --json
```

Run `agent-debug-relay --help` for breakpoint, execution, inspection, output, and session-selection options. Every command accepts `--json` for agent-friendly structured output.

`eval` sends the expression to the selected debug adapter and can execute side effects, like evaluation in a debugger watch or immediate window.

The CLI talks to authenticated localhost endpoints published by running VS Code windows with the Agent Debug Relay extension installed and enabled.
