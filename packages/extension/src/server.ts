import * as http from "http";
import * as vscode from "vscode";
import { getLaunchProfiles } from "./launchProfiles";
import { CAPABILITIES, PROTOCOL_VERSION } from "./protocol";
import { DebugSessionState, DebugSourceLocation, InstanceRecord } from "./types";

type RecordProvider = () => InstanceRecord;
type JsonObject = Record<string, unknown>;
const DEFAULT_STOP_WAIT_MS = 15_000;
const STOP_POLL_MS = 100;
const OUTPUT_LIMIT = 1_000;
const TERMINATED_SESSION_LIMIT = 20;

type OutputRecord = JsonObject & {
  sequence: number;
  timestamp: string;
};

export class AgentDebugServer {
  private server: http.Server | undefined;
  private portValue: number | undefined;
  private readonly sessions = new Map<string, vscode.DebugSession>();
  private readonly sessionStates = new Map<string, DebugSessionState>();
  private readonly terminatedSessions = new Map<string, JsonObject>();
  private readonly outputBySession = new Map<string, OutputRecord[]>();
  private outputSequence = 0;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly getRecord: RecordProvider,
    private readonly notifyOnLaunch: () => boolean
  ) {
    const active = vscode.debug.activeDebugSession;
    if (active) {
      this.trackSession(active);
    }

    this.disposables.push(
      vscode.debug.onDidStartDebugSession((session) => {
        this.trackSession(session);
      }),
      vscode.debug.onDidTerminateDebugSession((session) => {
        this.markTerminated(session);
        this.sessions.delete(session.id);
      }),
      vscode.debug.registerDebugAdapterTrackerFactory("*", {
        createDebugAdapterTracker: (session) => ({
          onDidSendMessage: (message) => {
            void this.handleAdapterMessage(session, message);
          }
        })
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

    if (url.pathname === "/status" && method === "GET") {
      const record = this.getRecord();
      writeJson(response, 200, {
        ok: true,
        id: record.id,
        extensionVersion: record.extensionVersion,
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [...CAPABILITIES],
        pid: record.pid,
        updatedAt: record.updatedAt,
        active: this.debugSessionRecord(vscode.debug.activeDebugSession),
        sessions: this.sessionRecords(),
        terminated: [...this.terminatedSessions.values()]
      });
      return;
    }

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
        active: this.debugSessionRecord(vscode.debug.activeDebugSession),
        sessions: this.sessionRecords(),
        terminated: [...this.terminatedSessions.values()]
      });
      return;
    }

    if (url.pathname === "/breakpoints" && method === "GET") {
      writeJson(response, 200, { breakpoints: vscode.debug.breakpoints.map(breakpointRecord) });
      return;
    }

    if (url.pathname === "/breakpoints" && method === "POST") {
      writeJson(response, 200, await this.addBreakpoint(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/breakpoints/remove" && method === "POST") {
      writeJson(response, 200, this.removeBreakpoint(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/breakpoints/clear" && method === "POST") {
      const breakpoints = vscode.debug.breakpoints;
      vscode.debug.removeBreakpoints(breakpoints);
      writeJson(response, 200, { cleared: breakpoints.length, breakpoints: [] });
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

    if (url.pathname === "/debug-sessions/control" && method === "POST") {
      writeJson(response, 200, await this.controlDebugging(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/stack-trace" && method === "POST") {
      writeJson(response, 200, await this.stackTrace(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/locals" && method === "POST") {
      writeJson(response, 200, await this.locals(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/variables" && method === "POST") {
      writeJson(response, 200, await this.variables(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/evaluate" && method === "POST") {
      writeJson(response, 200, await this.evaluate(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/threads" && method === "POST") {
      writeJson(response, 200, await this.threads(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/exception-info" && method === "POST") {
      writeJson(response, 200, await this.exceptionInfo(await readJsonBody(request)));
      return;
    }

    if (url.pathname === "/debug-sessions/output" && method === "POST") {
      writeJson(response, 200, this.recentOutput(await readJsonBody(request)));
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
      active: this.debugSessionRecord(vscode.debug.activeDebugSession)
    };
  }

  private async stopDebugging(body: JsonObject): Promise<JsonObject> {
    const all = booleanBodyField(body, "all") ?? false;
    const allowNoSession = booleanBodyField(body, "allowNoSession") ?? false;
    const waitMs = numberBodyField(body, "waitMs") ?? DEFAULT_STOP_WAIT_MS;
    const session = all ? undefined : this.findSession(body);
    const targetSessions = all ? [...this.sessions.values()] : session ? [session] : [];
    const stopped = targetSessions.map((targetSession) => this.debugSessionRecord(targetSession)).filter((targetSession) => targetSession !== undefined);
    const stoppedIds = targetSessions.map((targetSession) => targetSession.id);

    if (!all && !session) {
      if (allowNoSession) {
        return {
          stopped: false,
          terminated: true,
          active: this.debugSessionRecord(vscode.debug.activeDebugSession),
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
      active: this.debugSessionRecord(vscode.debug.activeDebugSession)
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
    return [...this.sessions.values()].map((session) => this.debugSessionRecord(session)).filter((session) => session !== undefined);
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
      .map((session) => this.debugSessionRecord(session))
      .filter((session) => session !== undefined);
  }

  private trackSession(session: vscode.DebugSession): void {
    this.sessions.set(session.id, session);
    this.terminatedSessions.delete(session.id);
    this.sessionStates.set(session.id, {
      status: "running",
      lastEventAt: new Date().toISOString()
    });
  }

  private markTerminated(session: vscode.DebugSession): void {
    const state: DebugSessionState = {
      ...(this.sessionStates.get(session.id) ?? { lastEventAt: new Date().toISOString() }),
      status: "terminated",
      lastEventAt: new Date().toISOString()
    };
    this.sessionStates.set(session.id, state);
    this.terminatedSessions.set(session.id, this.debugSessionRecord(session) ?? { id: session.id, state });

    while (this.terminatedSessions.size > TERMINATED_SESSION_LIMIT) {
      const oldestId = this.terminatedSessions.keys().next().value as string | undefined;
      if (!oldestId) {
        break;
      }
      this.terminatedSessions.delete(oldestId);
      this.sessionStates.delete(oldestId);
      this.outputBySession.delete(oldestId);
    }
  }

  private async handleAdapterMessage(session: vscode.DebugSession, message: unknown): Promise<void> {
    const eventMessage = asObject(message);
    if (eventMessage?.type !== "event" || typeof eventMessage.event !== "string") {
      return;
    }

    if (!this.sessions.has(session.id)) {
      this.trackSession(session);
    }

    const event = eventMessage.event;
    const body = asObject(eventMessage.body) ?? {};
    const now = new Date().toISOString();
    const current = this.sessionStates.get(session.id) ?? { status: "running", lastEventAt: now };

    if (event === "stopped") {
      const state: DebugSessionState = {
        ...current,
        status: "paused",
        stopReason: stringField(body.reason),
        stopDescription: stringField(body.description) ?? stringField(body.text),
        activeThreadId: numberField(body.threadId),
        allThreadsStopped: booleanField(body.allThreadsStopped),
        location: undefined,
        lastEventAt: now
      };
      this.sessionStates.set(session.id, state);
      await this.refreshStoppedLocation(session, state);
      return;
    }

    if (event === "continued") {
      this.sessionStates.set(session.id, {
        status: "running",
        activeThreadId: numberField(body.threadId) ?? current.activeThreadId,
        lastEventAt: now
      });
      return;
    }

    if (event === "terminated") {
      this.markTerminated(session);
      return;
    }

    if (event === "output") {
      const records = this.outputBySession.get(session.id) ?? [];
      records.push({
        sequence: ++this.outputSequence,
        timestamp: now,
        ...body
      });
      if (records.length > OUTPUT_LIMIT) {
        records.splice(0, records.length - OUTPUT_LIMIT);
      }
      this.outputBySession.set(session.id, records);
    }
  }

  private async refreshStoppedLocation(session: vscode.DebugSession, state: DebugSessionState): Promise<void> {
    try {
      const threadId = state.activeThreadId ?? await this.resolveThreadId(session, {});
      const response = asObject(await session.customRequest("stackTrace", {
        threadId,
        startFrame: 0,
        levels: 20
      }));
      const location = arrayField(response, "stackFrames")
        .map(asObject)
        .filter((frame): frame is JsonObject => frame !== undefined)
        .map(sourceLocation)
        .find((candidate) => candidate !== undefined);
      const latest = this.sessionStates.get(session.id);
      if (latest?.status === "paused" && (latest.activeThreadId === undefined || latest.activeThreadId === threadId)) {
        this.sessionStates.set(session.id, { ...latest, activeThreadId: threadId, location });
      }
    } catch {
      // Some adapters do not make the top frame available immediately after stopped.
    }
  }

  private debugSessionRecord(session: vscode.DebugSession | undefined): JsonObject | undefined {
    if (!session) {
      return undefined;
    }

    return {
      id: session.id,
      name: session.name,
      type: session.type,
      workspaceFolder: session.workspaceFolder?.uri.toString(),
      state: this.sessionStates.get(session.id) ?? {
        status: "running",
        lastEventAt: new Date().toISOString()
      }
    };
  }

  private async addBreakpoint(body: JsonObject): Promise<JsonObject> {
    const file = requiredString(body, "file");
    const line = requiredPositiveInteger(body, "line");
    const condition = stringBodyField(body, "condition");
    const breakpoint = new vscode.SourceBreakpoint(
      new vscode.Location(vscode.Uri.file(file), new vscode.Position(line - 1, 0)),
      true,
      condition
    );
    vscode.debug.addBreakpoints([breakpoint]);
    return { added: breakpointRecord(breakpoint), breakpoints: vscode.debug.breakpoints.map(breakpointRecord) };
  }

  private removeBreakpoint(body: JsonObject): JsonObject {
    const id = stringBodyField(body, "id");
    const file = stringBodyField(body, "file");
    const line = numberBodyField(body, "line");
    const matches = vscode.debug.breakpoints.filter((breakpoint) => {
      if (id) {
        return breakpoint.id === id;
      }
      if (!(breakpoint instanceof vscode.SourceBreakpoint) || !file || line === undefined) {
        return false;
      }
      return normalizeFilePath(breakpoint.location.uri.fsPath) === normalizeFilePath(file)
        && breakpoint.location.range.start.line + 1 === line;
    });

    if (matches.length === 0) {
      throw Object.assign(new Error("breakpoint not found"), { statusCode: 404 });
    }

    vscode.debug.removeBreakpoints(matches);
    return { removed: matches.map(breakpointRecord), breakpoints: vscode.debug.breakpoints.map(breakpointRecord) };
  }

  private async controlDebugging(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const action = requiredString(body, "action");
    const requests: Record<string, string> = {
      pause: "pause",
      continue: "continue",
      "step-over": "next",
      "step-in": "stepIn",
      "step-out": "stepOut"
    };
    const request = requests[action];
    if (!request) {
      throw Object.assign(new Error(`unsupported execution action: ${action}`), { statusCode: 400 });
    }
    const threadId = await this.resolveThreadId(session, body);
    const result = await session.customRequest(request, { threadId });
    return { action, threadId, result: result ?? {}, session: this.debugSessionRecord(session) };
  }

  private async stackTrace(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const threadId = await this.resolveThreadId(session, body);
    const response = asObject(await session.customRequest("stackTrace", {
      threadId,
      startFrame: numberBodyField(body, "startFrame"),
      levels: numberBodyField(body, "levels")
    })) ?? {};
    return { session: this.debugSessionRecord(session), threadId, ...response };
  }

  private async locals(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const frame = await this.resolveFrame(session, body);
    const response = asObject(await session.customRequest("scopes", { frameId: numberField(frame.id) })) ?? {};
    const scopes = arrayField(response, "scopes").map(asObject).filter((scope): scope is JsonObject => scope !== undefined);
    const localScopes = scopes.filter((scope) => stringField(scope.presentationHint) === "locals" || stringField(scope.name)?.toLowerCase() === "locals");
    const selected = localScopes.length > 0 ? localScopes : scopes.filter((scope) => scope.expensive !== true);
    const populated = await Promise.all(selected.map(async (scope) => {
      const variablesReference = numberField(scope.variablesReference);
      const variables = variablesReference && variablesReference > 0
        ? asObject(await session.customRequest("variables", { variablesReference }))
        : undefined;
      return { ...scope, variables: arrayField(variables, "variables") };
    }));
    return { session: this.debugSessionRecord(session), frame, scopes: populated };
  }

  private async variables(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const variablesReference = requiredPositiveInteger(body, "variablesReference");
    const response = asObject(await session.customRequest("variables", {
      variablesReference,
      filter: stringBodyField(body, "filter"),
      start: numberBodyField(body, "start"),
      count: numberBodyField(body, "count")
    })) ?? {};
    return { session: this.debugSessionRecord(session), variablesReference, ...response };
  }

  private async evaluate(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const expression = requiredString(body, "expression");
    let frameId = numberBodyField(body, "frameId");
    if (frameId === undefined && this.sessionStates.get(session.id)?.status === "paused") {
      frameId = numberField((await this.resolveFrame(session, body)).id);
    }
    const response = asObject(await session.customRequest("evaluate", {
      expression,
      frameId,
      context: stringBodyField(body, "context") ?? "repl"
    })) ?? {};
    return { session: this.debugSessionRecord(session), expression, frameId, ...response };
  }

  private async threads(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const response = asObject(await session.customRequest("threads")) ?? {};
    return { session: this.debugSessionRecord(session), ...response };
  }

  private async exceptionInfo(body: JsonObject): Promise<JsonObject> {
    const session = this.requireSession(body);
    const threadId = await this.resolveThreadId(session, body);
    const response = asObject(await session.customRequest("exceptionInfo", { threadId })) ?? {};
    return { session: this.debugSessionRecord(session), threadId, ...response };
  }

  private recentOutput(body: JsonObject): JsonObject {
    const sessionId = this.resolveOutputSessionId(body);
    const tail = numberBodyField(body, "tail") ?? 100;
    if (!Number.isInteger(tail) || tail < 0) {
      throw Object.assign(new Error("tail must be a non-negative integer"), { statusCode: 400 });
    }
    const records = this.outputBySession.get(sessionId) ?? [];
    const output = tail === 0 ? [] : records.slice(-tail);
    return { sessionId, count: output.length, totalCaptured: records.length, output };
  }

  private requireSession(body: JsonObject): vscode.DebugSession {
    const session = this.findSession(body);
    if (!session) {
      throw Object.assign(new Error("debug session not found"), { statusCode: 404 });
    }
    return session;
  }

  private async resolveThreadId(session: vscode.DebugSession, body: JsonObject): Promise<number> {
    const requested = numberBodyField(body, "threadId");
    const active = this.sessionStates.get(session.id)?.activeThreadId;
    if (requested !== undefined) {
      return requested;
    }
    if (active !== undefined) {
      return active;
    }
    const response = asObject(await session.customRequest("threads"));
    const first = asObject(arrayField(response, "threads")[0]);
    const threadId = numberField(first?.id);
    if (threadId === undefined) {
      throw Object.assign(new Error("debug adapter did not report a thread"), { statusCode: 409 });
    }
    return threadId;
  }

  private async resolveFrame(session: vscode.DebugSession, body: JsonObject): Promise<JsonObject> {
    const frameId = numberBodyField(body, "frameId");
    if (frameId !== undefined) {
      return { id: frameId };
    }
    const threadId = await this.resolveThreadId(session, body);
    const response = asObject(await session.customRequest("stackTrace", { threadId, startFrame: 0, levels: 1 }));
    const frame = asObject(arrayField(response, "stackFrames")[0]);
    if (!frame || numberField(frame.id) === undefined) {
      throw Object.assign(new Error("debug adapter did not report a stack frame"), { statusCode: 409 });
    }
    return frame;
  }

  private resolveOutputSessionId(body: JsonObject): string {
    const selector = stringBodyField(body, "sessionId") ?? stringBodyField(body, "session") ?? stringBodyField(body, "sessionName");
    if (selector) {
      const live = this.sessions.get(selector) ?? [...this.sessions.values()].find((session) => session.name === selector);
      if (live) {
        return live.id;
      }
      if (this.outputBySession.has(selector) || this.terminatedSessions.has(selector)) {
        return selector;
      }
      const terminated = [...this.terminatedSessions.entries()].reverse().find(([, record]) => record.name === selector);
      if (terminated) {
        return terminated[0];
      }
      throw Object.assign(new Error("debug session not found"), { statusCode: 404 });
    }
    const active = vscode.debug.activeDebugSession;
    if (active) {
      return active.id;
    }
    const latest = [...this.outputBySession.entries()].reduce<{ id: string; sequence: number } | undefined>((current, [id, records]) => {
      const sequence = records.at(-1)?.sequence ?? -1;
      return !current || sequence > current.sequence ? { id, sequence } : current;
    }, undefined)?.id ?? [...this.terminatedSessions.keys()].at(-1);
    if (latest) {
      return latest;
    }
    throw Object.assign(new Error("debug session not found"), { statusCode: 404 });
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

function requiredString(body: JsonObject, key: string): string {
  const value = stringBodyField(body, key);
  if (!value) {
    throw Object.assign(new Error(`${key} is required`), { statusCode: 400 });
  }
  return value;
}

function requiredPositiveInteger(body: JsonObject, key: string): number {
  const value = numberBodyField(body, key);
  if (!Number.isInteger(value) || value === undefined || value <= 0) {
    throw Object.assign(new Error(`${key} must be a positive integer`), { statusCode: 400 });
  }
  return value;
}

function asObject(value: unknown): JsonObject | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as JsonObject : undefined;
}

function arrayField(object: JsonObject | undefined, key: string): unknown[] {
  const value = object?.[key];
  return Array.isArray(value) ? value : [];
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function booleanField(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function breakpointRecord(breakpoint: vscode.Breakpoint): JsonObject {
  const base: JsonObject = {
    id: breakpoint.id,
    enabled: breakpoint.enabled,
    condition: breakpoint.condition,
    hitCondition: breakpoint.hitCondition,
    logMessage: breakpoint.logMessage
  };

  if (breakpoint instanceof vscode.SourceBreakpoint) {
    return {
      ...base,
      kind: "source",
      uri: breakpoint.location.uri.toString(),
      file: breakpoint.location.uri.fsPath,
      line: breakpoint.location.range.start.line + 1,
      column: breakpoint.location.range.start.character + 1
    };
  }

  if (breakpoint instanceof vscode.FunctionBreakpoint) {
    return { ...base, kind: "function", functionName: breakpoint.functionName };
  }

  return { ...base, kind: "unknown" };
}

function normalizeFilePath(file: string): string {
  return process.platform === "win32" ? file.toLowerCase() : file;
}

function sourceLocation(frame: JsonObject | undefined): DebugSourceLocation | undefined {
  if (!frame) {
    return undefined;
  }
  const source = asObject(frame.source);
  const line = numberField(frame.line);
  const name = stringField(source?.name);
  const path = stringField(source?.path);
  const sourceReference = positiveNumberField(source?.sourceReference);
  if (line === undefined || line <= 0 || (!name && !path && sourceReference === undefined)) {
    return undefined;
  }
  return {
    name,
    path,
    sourceReference,
    line,
    column: positiveNumberField(frame.column)
  };
}

function positiveNumberField(value: unknown): number | undefined {
  const number = numberField(value);
  return number !== undefined && number > 0 ? number : undefined;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
