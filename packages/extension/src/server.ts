import * as http from "http";
import * as vscode from "vscode";
import { getLaunchProfiles } from "./launchProfiles";
import { CAPABILITIES, PROTOCOL_VERSION } from "./protocol";
import { InstanceRecord } from "./types";

type RecordProvider = () => InstanceRecord;
type JsonObject = Record<string, unknown>;
const DEFAULT_STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 100;

export class AgentDebugServer {
  private server: http.Server | undefined;
  private portValue: number | undefined;
  private readonly sessions = new Map<string, vscode.DebugSession>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly getRecord: RecordProvider,
    private readonly notifyOnLaunch: () => boolean
  ) {
    const active = vscode.debug.activeDebugSession;
    if (active) {
      this.sessions.set(active.id, active);
    }

    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.sessions.set(session.id, session);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.sessions.delete(session.id);
      })
    );
  }

  get port(): number {
    if (this.portValue === undefined) {
      throw new Error("server has not started");
    }

    return this.portValue;
  }

  async start(): Promise<void> {
    this.server = http.createServer((request, response) => {
      this.handleRequest(request, response).catch((error: unknown) => {
        writeJson(response, statusForError(error), {
          error: error instanceof Error ? error.message : String(error)
        });
      });
    });

    await new Promise<void>((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(0, this.host, () => {
        this.server?.off("error", reject);
        const address = this.server?.address();
        if (!address || typeof address === "string") {
          reject(new Error("server did not publish a TCP address"));
          return;
        }

        this.portValue = address.port;
        resolve();
      });
    });
  }

  async dispose(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.portValue = undefined;

    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }

    if (!server) {
      return;
    }

    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  private async handleRequest(request: http.IncomingMessage, response: http.ServerResponse): Promise<void> {
    const method = request.method ?? "GET";
    const url = new URL(request.url ?? "/", `http://${this.host}`);

    if (url.pathname === "/health" && method === "GET") {
      const record = this.getRecord();
      writeJson(response, 200, {
        ok: true,
        id: record.id,
        extensionVersion: record.extensionVersion,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...CAPABILITIES],
        pid: record.pid,
        updatedAt: record.updatedAt
      });
      return;
    }

    this.requireAuth(request);

    if (url.pathname === "/instance" && method === "GET") {
      writeJson(response, 200, this.getRecord());
      return;
    }

    if (url.pathname === "/launch-profiles" && method === "GET") {
      writeJson(response, 200, {
        profiles: await getLaunchProfiles()
      });
      return;
    }

    if (url.pathname === "/debug-sessions" && method === "GET") {
      writeJson(response, 200, {
        active: debugSessionRecord(vscode.debug.activeDebugSession),
        sessions: this.sessionRecords()
      });
      return;
    }

    if (url.pathname === "/debug-sessions" && method === "POST") {
      const body = await readJsonBody(request);
      const result = await this.startDebugging(body);
      writeJson(response, 200, result);
      return;
    }

    if (url.pathname === "/debug-sessions/stop" && method === "POST") {
      const body = await readJsonBody(request);
      const result = await this.stopDebugging(body);
      writeJson(response, 200, result);
      return;
    }

    if (url.pathname === "/debug-sessions/restart" && method === "POST") {
      const body = await readJsonBody(request);
      const result = await this.restartDebugging(body);
      writeJson(response, 200, result);
      return;
    }

    writeJson(response, 404, {
      error: "unknown endpoint"
    });
  }

  private requireAuth(request: http.IncomingMessage): void {
    const header = request.headers.authorization;
    const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice("Bearer ".length) : undefined;
    const explicit = request.headers["x-agent-debug-token"];
    const headerToken = typeof explicit === "string" ? explicit : undefined;

    if (bearer !== this.token && headerToken !== this.token) {
      throw Object.assign(new Error("unauthorized"), { statusCode: 401 });
    }
  }

  private async startDebugging(body: JsonObject): Promise<JsonObject> {
    const profileName = stringBodyField(body, "profileName") ?? stringBodyField(body, "name");
    const folderUri = stringBodyField(body, "folderUri");
    const noDebug = booleanBodyField(body, "noDebug");

    if (!profileName) {
      throw Object.assign(new Error("profileName is required"), { statusCode: 400 });
    }

    const folder = findWorkspaceFolder(folderUri);
    const profile = objectBodyField(body, "profile");
    const configuration = dotnetLaunchSettingsConfiguration(profile);
    const started = await vscode.debug.startDebugging(folder, configuration ?? profileName, { noDebug });

    if (started && this.notifyOnLaunch()) {
      void vscode.window.showInformationMessage(`Agent Debug Relay started ${profileName}`);
    }

    return {
      started,
      profileName,
      kind: stringField(profile?.kind),
      folderUri: folder?.uri.toString(),
      projectPath: stringField(profile?.projectPath),
      launchSettingsPath: stringField(profile?.launchSettingsPath),
      launchSettingsProfile: stringField(profile?.launchSettingsProfile),
      active: debugSessionRecord(vscode.debug.activeDebugSession)
    };
  }

  private async stopDebugging(body: JsonObject): Promise<JsonObject> {
    const all = booleanBodyField(body, "all") ?? false;
    const allowNoSession = booleanBodyField(body, "allowNoSession") ?? false;
    const waitMs = numberBodyField(body, "waitMs") ?? DEFAULT_STOP_WAIT_MS;
    const session = all ? undefined : this.findSession(body);
    const targetSessions = all ? [...this.sessions.values()] : session ? [session] : [];
    const stopped = targetSessions.map((targetSession) => debugSessionRecord(targetSession)).filter((targetSession) => targetSession !== undefined);
    const stoppedIds = targetSessions.map((targetSession) => targetSession.id);

    if (!all && !session) {
      if (allowNoSession) {
        return {
          stopped: false,
          terminated: true,
          active: debugSessionRecord(vscode.debug.activeDebugSession),
          sessions: this.sessionRecords()
        };
      }

      throw Object.assign(new Error("debug session not found"), { statusCode: 404 });
    }

    await vscode.debug.stopDebugging(session);

    const wait = await this.waitForSessionsToStop(stoppedIds, waitMs);

    if (!wait.terminated) {
      throw Object.assign(new Error(`debug session did not terminate within ${waitMs}ms`), {
        statusCode: 504,
        remainingSessions: wait.remaining
      });
    }

    return {
      stopped: true,
      terminated: wait.terminated,
      waitMs,
      stoppedSessions: stopped,
      active: debugSessionRecord(vscode.debug.activeDebugSession)
    };
  }

  private async restartDebugging(body: JsonObject): Promise<JsonObject> {
    const profileName = stringBodyField(body, "profileName") ?? stringBodyField(body, "name");

    if (!profileName) {
      throw Object.assign(new Error("profileName is required"), { statusCode: 400 });
    }

    const stopBody = {
      ...body,
      sessionName: stringBodyField(body, "sessionName") ?? stringBodyField(body, "session") ?? profileName,
      allowNoSession: true
    };
    const stopped = await this.stopDebugging(stopBody);
    const started = await this.startDebugging(body);

    return {
      stopped,
      started
    };
  }

  private sessionRecords(): JsonObject[] {
    return [...this.sessions.values()].map((session) => debugSessionRecord(session)).filter((session) => session !== undefined);
  }

  private async waitForSessionsToStop(sessionIds: string[], waitMs: number): Promise<{ terminated: boolean; remaining: JsonObject[] }> {
    if (sessionIds.length === 0 || waitMs <= 0) {
      return {
        terminated: sessionIds.every((sessionId) => !this.sessions.has(sessionId)),
        remaining: this.recordsForSessionIds(sessionIds)
      };
    }

    const deadline = Date.now() + waitMs;

    while (Date.now() < deadline) {
      if (sessionIds.every((sessionId) => !this.sessions.has(sessionId))) {
        return {
          terminated: true,
          remaining: []
        };
      }

      await sleep(STOP_POLL_MS);
    }

    return {
      terminated: sessionIds.every((sessionId) => !this.sessions.has(sessionId)),
      remaining: this.recordsForSessionIds(sessionIds)
    };
  }

  private recordsForSessionIds(sessionIds: string[]): JsonObject[] {
    return sessionIds
      .map((sessionId) => this.sessions.get(sessionId))
      .filter((session) => session !== undefined)
      .map((session) => debugSessionRecord(session))
      .filter((session) => session !== undefined);
  }

  private findSession(body: JsonObject): vscode.DebugSession | undefined {
    const sessionId = stringBodyField(body, "sessionId");
    const sessionSelector = stringBodyField(body, "session");
    const sessionName = stringBodyField(body, "sessionName");

    if (sessionId) {
      return this.sessions.get(sessionId);
    }

    if (sessionSelector) {
      return this.sessions.get(sessionSelector) ?? [...this.sessions.values()].find((session) => session.name === sessionSelector);
    }

    if (sessionName) {
      return [...this.sessions.values()].find((session) => session.name === sessionName);
    }

    return vscode.debug.activeDebugSession;
  }
}

function findWorkspaceFolder(folderUri: string | undefined): vscode.WorkspaceFolder | undefined {
  if (!folderUri) {
    return vscode.workspace.workspaceFolders?.[0];
  }

  const folder = vscode.workspace.workspaceFolders?.find((candidate) => {
    return candidate.uri.toString() === folderUri || candidate.uri.fsPath === folderUri;
  });

  if (!folder) {
    throw Object.assign(new Error(`workspace folder not found: ${folderUri}`), { statusCode: 400 });
  }

  return folder;
}

function debugSessionRecord(session: vscode.DebugSession | undefined): JsonObject | undefined {
  if (!session) {
    return undefined;
  }

  return {
    id: session.id,
    name: session.name,
    type: session.type,
    workspaceFolder: session.workspaceFolder?.uri.toString()
  };
}

async function readJsonBody(request: http.IncomingMessage): Promise<JsonObject> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  const parsed = JSON.parse(raw) as unknown;

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw Object.assign(new Error("request body must be a JSON object"), { statusCode: 400 });
  }

  return parsed as JsonObject;
}

function writeJson(response: http.ServerResponse, statusCode: number, body: unknown): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  response.end(JSON.stringify(body, null, 2));
}

function statusForError(error: unknown): number {
  if (error && typeof error === "object" && "statusCode" in error && typeof error.statusCode === "number") {
    return error.statusCode;
  }

  return 500;
}

function stringBodyField(body: JsonObject, key: string): string | undefined {
  const value = body[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function objectBodyField(body: JsonObject, key: string): JsonObject | undefined {
  const value = body[key];
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function dotnetLaunchSettingsConfiguration(profile: JsonObject | undefined): vscode.DebugConfiguration | undefined {
  if (!profile || profile.kind !== "dotnetLaunchSettings") {
    return undefined;
  }

  const name = stringField(profile.name);
  const projectPath = stringField(profile.projectPath);
  const launchSettingsProfile = stringField(profile.launchSettingsProfile) ?? name;
  const launchSettingsFilePath = stringField(profile.launchSettingsPath);

  if (!name || !projectPath || !launchSettingsProfile) {
    return undefined;
  }

  return {
    name,
    type: "dotnet",
    request: "launch",
    projectPath,
    launchSettingsProfile,
    launchSettingsFilePath
  };
}

function booleanBodyField(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function numberBodyField(body: JsonObject, key: string): number | undefined {
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
