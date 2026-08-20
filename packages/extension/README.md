# Agent Debug Relay

Agent Debug Relay lets local agents discover running VS Code windows and control and inspect debug sessions through VS Code's native debug API and standard DAP requests.

Install the extension in VS Code, then install the CLI separately:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

Install the agent skill for Codex, Claude Code, or opencode:

```powershell
npx skills add bluebearworks/agent-debug-relay -g -a codex claude-code opencode -s agent-debug-relay -y --copy --full-depth
```

The extension publishes an authenticated localhost endpoint for each VS Code window. The CLI reads the local registry, selects the right running window, and sends debug lifecycle, breakpoint, execution, inspection, and output requests to that extension instance. Profile discovery includes VS Code `launch.json` configurations, compounds, and .NET profiles from `<project>/Properties/launchSettings.json`.

Breakpoint management uses VS Code's breakpoint API. Execution and inspection use standard DAP requests through the active `DebugSession`. Session responses track running, paused, and terminated state plus stop reason, thread, source location, and recent DAP output when supplied by the adapter.

Reload already-open VS Code windows after installing or upgrading the extension.
