import * as http from "http";
import * as vscode from "vscode";
import { getLaunchProfiles } from "./launchProfiles";
import { InstanceRecord } from "./types";

type RecordProvider = () => InstanceRecord;
type JsonObject = Record<string, unknown>;

export class AgentDebugServer {
  private server: http.Server | undefined;
  private portValue: number | undefined;

  constructor(
    private readonly host: string,
    private readonly token: string,
    private readonly getRecord: RecordProvider,
    private readonly notifyOnLaunch: () => boolean
  ) {}

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
        profiles: getLaunchProfiles()
      });
      return;
    }

    if (url.pathname === "/debug-sessions" && method === "GET") {
      writeJson(response, 200, {
        active: debugSessionRecord(vscode.debug.activeDebugSession)
      });
      return;
    }

    if (url.pathname === "/debug-sessions" && method === "POST") {
      const body = await readJsonBody(request);
      const result = await this.startDebugging(body);
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
    const started = await vscode.debug.startDebugging(folder, profileName, { noDebug });

    if (started && this.notifyOnLaunch()) {
      void vscode.window.showInformationMessage(`agent debug started ${profileName}`);
    }

    return {
      started,
      profileName,
      folderUri: folder?.uri.toString(),
      active: debugSessionRecord(vscode.debug.activeDebugSession)
    };
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

function booleanBodyField(body: JsonObject, key: string): boolean | undefined {
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

