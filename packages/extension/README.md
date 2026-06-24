# Agent Debug Relay

Agent Debug Relay lets local agents discover running VS Code windows, list the active workspace's launch profiles, and control debug sessions through VS Code's native debug API.

Install the extension in VS Code, then install the CLI separately:

```powershell
npm install -g @bluebearworks/agent-debug-relay
```

Install the agent skill for Codex, Claude Code, or opencode:

```powershell
npx skills add bluebearworks/agent-debug-relay -g -a codex claude-code opencode -s agent-debug-relay -y --copy --full-depth
```

The extension publishes an authenticated localhost endpoint for each VS Code window. The CLI reads the local registry, selects the right running window, and sends debug lifecycle requests to that extension instance.

Reload already-open VS Code windows after installing or upgrading the extension.
