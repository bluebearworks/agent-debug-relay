# Agent Debug Relay

Agent Debug Relay lets local agents discover running VS Code windows, work with debug sessions, and run commands in visible integrated terminals. It covers launch profiles, debugger lifecycle and inspection, terminal command execution, captured output, input, and terminal shutdown.

## Packages

This repo is a monorepo with two publishable parts:

| Package | Purpose | Distribution |
| --- | --- | --- |
| `packages/extension` | VS Code extension that runs inside each VS Code window and publishes the local endpoint. | VS Code Marketplace / VSIX as `bluebearworks.agent-debug-relay` |
| `packages/cli` | Terminal command agents use to discover windows and control debug sessions and integrated terminals. | npm as `@bluebearworks/agent-debug-relay` |

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

Install the agent skill for the agents you use:

```powershell
npx skills add bluebearworks/agent-debug-relay -g -a codex claude-code opencode -s agent-debug-relay -y --copy --full-depth
```

Use a single `-a` target when you only want one agent:

```powershell
npx skills add bluebearworks/agent-debug-relay -g -a codex -s agent-debug-relay -y --copy --full-depth
npx skills add bluebearworks/agent-debug-relay -g -a claude-code -s agent-debug-relay -y --copy --full-depth
npx skills add bluebearworks/agent-debug-relay -g -a opencode -s agent-debug-relay -y --copy --full-depth
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

Every command accepts `--json` for machine-readable output. Use `--session`, `--session-id`, or `--session-name` when more than one debug session is running.

### Breakpoints

```powershell
agent-debug-relay breakpoint add .\src\Program.cs:24 --workspace C:\path\to\repo --json
agent-debug-relay breakpoint add .\src\Program.cs:31 --condition "order.Total > 100" --workspace C:\path\to\repo --json
agent-debug-relay breakpoint list --workspace C:\path\to\repo --json
agent-debug-relay breakpoint remove .\src\Program.cs:24 --workspace C:\path\to\repo --json
agent-debug-relay breakpoint clear --workspace C:\path\to\repo --json
```

Breakpoint paths are resolved from the CLI's current directory. Line numbers are one-based.

### Pause and step

```powershell
agent-debug-relay pause --workspace C:\path\to\repo --json
agent-debug-relay continue --workspace C:\path\to\repo --json
agent-debug-relay step-over --workspace C:\path\to\repo --json
agent-debug-relay step-in --workspace C:\path\to\repo --json
agent-debug-relay step-out --workspace C:\path\to\repo --json
```

The relay uses the thread from the latest stopped event when available. Pass `--thread-id` to select another thread.

### Inspect paused code

```powershell
agent-debug-relay threads --workspace C:\path\to\repo --json
agent-debug-relay stack --workspace C:\path\to\repo --json
agent-debug-relay locals --workspace C:\path\to\repo --json
agent-debug-relay variables 1234 --workspace C:\path\to\repo --json
agent-debug-relay eval "customer.Total" --workspace C:\path\to\repo --json
agent-debug-relay exception --workspace C:\path\to\repo --json
agent-debug-relay output --tail 50 --workspace C:\path\to\repo --json
```

`stack`, `locals`, `eval`, and `exception` default to the active stopped thread and top frame. `variables` expands a `variablesReference` returned by `locals`, `variables`, or `eval`.

Expression evaluation is potentially side-effectful. The selected debugger evaluates the expression with DAP's `evaluate` request, so use `eval` with the same care as a debugger watch or immediate window.

### Integrated terminals

```powershell
agent-debug-relay terminal list --workspace C:\path\to\repo --json
agent-debug-relay terminal run "npm start" --name "dev server" --cwd C:\path\to\repo --workspace C:\path\to\repo --json
agent-debug-relay terminal run "npm test" --wait --wait-ms 120000 --workspace C:\path\to\repo --json
agent-debug-relay terminal output terminal-1 --tail 50 --workspace C:\path\to\repo --json
agent-debug-relay terminal input "r" --terminal terminal-1 --no-enter --workspace C:\path\to\repo --json
agent-debug-relay terminal interrupt terminal-1 --workspace C:\path\to\repo --json
agent-debug-relay terminal wait terminal-1 --wait-ms 30000 --workspace C:\path\to\repo --json
agent-debug-relay terminal stop terminal-1 --workspace C:\path\to\repo --json
```

`terminal run` creates and reveals a normal VS Code integrated terminal when no terminal selector is supplied. Pass `--terminal`, `--terminal-id`, or `--terminal-name` to run in an existing terminal. Add `--wait` to wait for that command's shell execution to finish. `terminal wait` waits for an already-running command, and returns `completed: false` if the timeout expires. `terminal input` appends Enter by default; use `--no-enter` for interactive input. `terminal interrupt` sends Ctrl+C while leaving the integrated terminal open. `terminal stop` disposes the selected terminal and its shell process, matching VS Code's terminal trash action.

VS Code shell integration provides command state, exit codes, output capture, and terminal waiting. When shell integration is unavailable, the relay runs the command with `Terminal.sendText`; the terminal remains visible, interruptible, and controllable, while command output, waiting, and exit state are unavailable to the relay. A `terminal run --wait` response identifies this case with `wait.unavailable` and still returns the terminal id. Captured output starts when the extension observes a command execution and does not include earlier terminal scrollback.

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
code --install-extension .\packages\extension\agent-debug-relay-0.4.0.vsix --force
```

## Protocol

Each instance record includes:

```json
{
  "extensionVersion": "0.4.0",
  "protocolVersion": 5,
  "capabilities": [
    "profiles",
    "profileLifecycleFields",
    "sessions",
    "stop",
    "restart",
    "stopPolling",
    "breakpoints",
    "executionControl",
    "inspection",
    "debugOutput",
    "sessionState",
    "terminals",
    "terminalExecutionLifecycle"
  ]
}
```

The default registry folder is:

```text
~/.agent-debug-relay/instances
```

On Windows, `~` is your user profile directory. The shared home-directory location allows VS Code and agent shells to discover the same instances even when they use different temporary directories. The CLI also reads records from the system temp directories used by earlier extension versions.

For a custom location, set `AGENT_DEBUG_RELAY_REGISTRY_DIR` in both processes, or set `agentDebugRelay.registryDir` in VS Code and pass `--registry-dir <directory>` to the CLI. The CLI also accepts `--registry-dir=<directory>`. The VS Code setting takes precedence over its environment; the CLI flag takes precedence over its environment. Use an absolute path for overrides. Reload the VS Code window after changing its setting. Environment changes require the VS Code process to inherit the new environment; launching `code` can reuse an already-running process.

### Sandboxed agents

Update both the extension and CLI, then reload the VS Code window. Run `agent-debug-relay instances --json` from the agent shell. Discovery diagnostics go to stderr and include the searched directories when no instances are found. The JSON result remains on stdout.

The CLI retains records when the sandbox denies a process-existence check. Debugger and terminal commands authenticate to the selected localhost endpoint, so the agent also needs permission to read the registry and connect to that endpoint. A denied filesystem read is reported with its path and error code. Use the agent's supported permission controls to grant the required access.

## Debug Lifecycle

Profile discovery surfaces VS Code `launch.json` configurations, compounds, and .NET profiles from `<project>/Properties/launchSettings.json`. `preLaunchTask` and `postDebugTask` are returned as top-level fields alongside the full launch profile detail when they are present. For compiled services, put builds in `preLaunchTask` when possible so an agent `start` follows the same path as a manual VS Code launch.

For services that need a restart, agents can stop the active or selected debug session, wait for termination, then start the same profile again. `restart` is available for direct stop-and-start flows. `stop` and `restart` accept `--wait-ms <milliseconds>`; the default wait is 15000ms.

## Debug State and Adapter Support

Session and status responses include `running`, `paused`, or `terminated` state. Paused sessions include the DAP stop reason, active thread, and current source location when the adapter supplies a stack frame. The session list retains the 20 most recent terminated session records.

The extension captures the latest 1,000 DAP `output` events per session in memory. `output` returns the newest 100 entries by default; use `--tail` or `--count` to select another amount.

Interactive command availability follows the selected debug adapter's DAP capabilities and current state. Stack, scope, variable, evaluation, and exception requests generally require a paused session. Conditional breakpoint syntax and expression behavior are defined by the adapter and target language.

## Terminal State and Shell Integration

Terminal responses include relay ids, terminal names, active/managed state, working directory, process id, current command, shell-integration availability, and `idle`, `running`, `exited`, `closed`, or `unknown` status. `unknown` means a command was sent without shell integration, so VS Code cannot report its completion. The extension retains captured output and state for the 20 most recently closed terminals and the latest 1,000 output chunks per terminal.

The relay uses VS Code's stable terminal and shell-integration APIs. It can control terminals in the selected VS Code window, including terminals created outside the relay. Output capture begins with shell executions observed while the extension is active.
