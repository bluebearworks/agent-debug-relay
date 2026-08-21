# Agent Debug Relay CLI

CLI for discovering Agent Debug Relay VS Code windows and controlling debug sessions and integrated terminals.

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
agent-debug-relay terminal run "npm start" --name "dev server" --workspace C:\path\to\repo --json
agent-debug-relay terminal run "npm test" --wait --wait-ms 120000 --workspace C:\path\to\repo --json
agent-debug-relay terminal output terminal-1 --tail 50 --workspace C:\path\to\repo --json
agent-debug-relay terminal interrupt terminal-1 --workspace C:\path\to\repo --json
agent-debug-relay terminal wait terminal-1 --wait-ms 30000 --workspace C:\path\to\repo --json
agent-debug-relay terminal stop terminal-1 --workspace C:\path\to\repo --json
```

Run `agent-debug-relay --help` for debugger, terminal, output, and selection options. Every command accepts `--json` for agent-friendly structured output.

`eval` sends the expression to the selected debug adapter and can execute side effects, like evaluation in a debugger watch or immediate window.

The CLI talks to authenticated localhost endpoints published by running VS Code windows with the Agent Debug Relay extension installed and enabled.
