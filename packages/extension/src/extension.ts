import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { CAPABILITIES, PROTOCOL_VERSION } from "./protocol";
import { AgentDebugServer } from "./server";
import { ActiveEditorRecord, InstanceRecord, WorkspaceFolderRecord } from "./types";

const HEARTBEAT_MS = 5_000;
const CONFIG_SECTION = "agentDebugRelay";
const EXTENSION_ID = "bluebearworks.agent-debug-relay";
const REGISTRY_NAMESPACE = "agent-debug-relay";

let server: AgentDebugServer | undefined;
let record: InstanceRecord | undefined;
let registryPath: string | undefined;
let heartbeat: NodeJS.Timeout | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const config = vscode.workspace.getConfiguration(CONFIG_SECTION);

  if (!config.get<boolean>("enabled", true)) {
    return;
  }

  const token = await getOrCreateToken(context);
  const id = crypto.randomUUID();
  const host = config.get<string>("host", "127.0.0.1");

  server = new AgentDebugServer(host, token, () => {
    if (!record) {
      throw new Error("instance record is not ready");
    }

    return record;
  }, () => vscode.workspace.getConfiguration(CONFIG_SECTION).get<boolean>("notifyOnLaunch", true));

  await server.start();

  registryPath = path.join(getRegistryDir(), `${id}.json`);
  record = buildRecord(id, host, server.port, token, registryPath, new Date().toISOString());
  await publishRecord();

  heartbeat = setInterval(() => {
    void publishRecord();
  }, HEARTBEAT_MS);

  registerRefreshTriggers(context);

  context.subscriptions.push(
    vscode.commands.registerCommand("agentDebugRelay.showStatus", () => showStatus()),
    vscode.commands.registerCommand("agentDebugRelay.copyRegistryPath", async () => copyRegistryPath()),
    new vscode.Disposable(() => {
      if (heartbeat) {
        clearInterval(heartbeat);
        heartbeat = undefined;
      }
    })
  );
}

export async function deactivate(): Promise<void> {
  if (heartbeat) {
    clearInterval(heartbeat);
    heartbeat = undefined;
  }

  if (registryPath) {
    await fs.rm(registryPath, { force: true }).catch(() => undefined);
  }

  if (server) {
    await server.dispose();
    server = undefined;
  }
}

function registerRefreshTriggers(context: vscode.ExtensionContext): void {
  const refresh = () => {
    void publishRecord();
  };

  context.subscriptions.push(
    vscode.workspace.onDidChangeWorkspaceFolders(refresh),
    vscode.window.onDidChangeActiveTextEditor(refresh),
    vscode.window.onDidChangeWindowState(refresh),
    vscode.debug.onDidChangeActiveDebugSession(refresh),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("launch") || event.affectsConfiguration(CONFIG_SECTION)) {
        refresh();
      }
    })
  );
}

async function publishRecord(): Promise<void> {
  if (!record || !registryPath || !server) {
    return;
  }

  record = buildRecord(record.id, record.host, server.port, record.token, registryPath, record.createdAt);
  await fs.mkdir(path.dirname(registryPath), { recursive: true });
  const tempPath = `${registryPath}.${process.pid}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(record, null, 2), "utf8");
  await fs.rename(tempPath, registryPath);
}

function buildRecord(
  id: string,
  host: string,
  port: number,
  token: string,
  registryFile: string,
  createdAt: string
): InstanceRecord {
  return {
    id,
    extensionVersion: extensionVersion(),
    protocolVersion: PROTOCOL_VERSION,
    capabilities: [...CAPABILITIES],
    pid: process.pid,
    appName: vscode.env.appName,
    appHost: vscode.env.appHost,
    remoteName: vscode.env.remoteName,
    machineId: vscode.env.machineId,
    sessionId: vscode.env.sessionId,
    host,
    port,
    token,
    registryPath: registryFile,
    workspaceFile: vscode.workspace.workspaceFile?.fsPath,
    workspaceFolders: workspaceFolderRecords(),
    activeEditor: activeEditorRecord(),
    focused: vscode.window.state.focused,
    activeDebugSession: activeDebugSessionRecord(),
    createdAt,
    updatedAt: new Date().toISOString()
  };
}

function extensionVersion(): string {
  const manifest = vscode.extensions.getExtension(EXTENSION_ID)?.packageJSON as { version?: unknown } | undefined;
  return typeof manifest?.version === "string" ? manifest.version : "0.0.0";
}

function workspaceFolderRecords(): WorkspaceFolderRecord[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder, index) => ({
    name: folder.name,
    uri: folder.uri.toString(),
    path: folder.uri.fsPath,
    index
  }));
}

function activeEditorRecord(): ActiveEditorRecord {
  const editor = vscode.window.activeTextEditor;

  if (!editor) {
    return undefined;
  }

  return {
    uri: editor.document.uri.toString(),
    path: editor.document.uri.fsPath,
    languageId: editor.document.languageId
  };
}

function activeDebugSessionRecord(): InstanceRecord["activeDebugSession"] {
  const session = vscode.debug.activeDebugSession;

  if (!session) {
    return undefined;
  }

  return {
    id: session.id,
    name: session.name,
    type: session.type
  };
}

async function getOrCreateToken(context: vscode.ExtensionContext): Promise<string> {
  const existing = context.globalState.get<string>("agentDebugRelay.token");

  if (existing) {
    return existing;
  }

  const token = crypto.randomBytes(32).toString("hex");
  await context.globalState.update("agentDebugRelay.token", token);
  return token;
}

function getRegistryDir(): string {
  const configured = vscode.workspace.getConfiguration(CONFIG_SECTION).get<string>("registryDir", "");

  if (configured.trim().length > 0) {
    return path.resolve(configured);
  }

  return path.join(os.tmpdir(), REGISTRY_NAMESPACE, "instances");
}

async function showStatus(): Promise<void> {
  await publishRecord();

  if (!record) {
    void vscode.window.showInformationMessage("Agent Debug Relay is inactive");
    return;
  }

  void vscode.window.showInformationMessage(`Agent Debug Relay listening on ${record.host}:${record.port}`);
}

async function copyRegistryPath(): Promise<void> {
  await publishRecord();

  if (!registryPath) {
    void vscode.window.showInformationMessage("Agent Debug Relay registry path is unavailable");
    return;
  }

  await vscode.env.clipboard.writeText(registryPath);
  void vscode.window.showInformationMessage("Agent Debug Relay registry path copied");
}
