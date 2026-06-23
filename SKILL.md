# Agent Debug Skill

Use this skill when an agent needs VS Code to start a debug session in an already-running VS Code window.

## Workflow

1. Build or install the `vscode-agent-debug` extension, then make sure the target VS Code window has the extension activated.
2. Discover running windows:

```powershell
node C:\Users\Tyler\documents\projects\vscode-agent-debug\bin\vscode-agent-debug.js instances --workspace <repo-path> --json
```

3. List launch profiles from the selected window:

```powershell
node C:\Users\Tyler\documents\projects\vscode-agent-debug\bin\vscode-agent-debug.js profiles --workspace <repo-path> --json
```

4. Start the chosen profile by exact name:

```powershell
node C:\Users\Tyler\documents\projects\vscode-agent-debug\bin\vscode-agent-debug.js start "<profile name>" --workspace <repo-path> --json
```

For duplicate profile names in a multi-root workspace, add `--folder <workspace-folder-path-or-name>`.

## Selection Rules

Prefer `--workspace <repo-path>` for normal use. The CLI selects the running VS Code instance whose workspace folder contains that path, with the focused window winning ties.

Use `--instance <id>` when a previous discovery step selected a specific VS Code window.

## Launch Rules

Start existing named launch profiles whenever possible. Named profile launches use VS Code's `vscode.debug.startDebugging` API with the profile name, which keeps the behavior aligned with launching from the Run and Debug UI.

Use the profile names returned by `profiles`; preserve spelling, spacing, and folder identity.

## Troubleshooting

Run:

```powershell
node C:\Users\Tyler\documents\projects\vscode-agent-debug\bin\vscode-agent-debug.js status --workspace <repo-path> --json
```

The default registry folder is `%TEMP%\vscode-agent-debug\instances`. Set `VSCODE_AGENT_DEBUG_REGISTRY_DIR` or the VS Code setting `agentDebug.registryDir` when a custom location is useful.

