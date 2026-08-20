"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

let breakpointId = 0;
const debug = {
  activeDebugSession: undefined,
  breakpoints: [],
  addBreakpoints(breakpoints) {
    this.breakpoints.push(...breakpoints);
  },
  removeBreakpoints(breakpoints) {
    const ids = new Set(breakpoints.map((breakpoint) => breakpoint.id));
    this.breakpoints.splice(0, this.breakpoints.length, ...this.breakpoints.filter((breakpoint) => !ids.has(breakpoint.id)));
  },
  onDidStartDebugSession: disposableListener,
  onDidTerminateDebugSession: disposableListener,
  registerDebugAdapterTrackerFactory(debugType, factory) {
    this.trackerRegistration = { debugType, factory };
    return disposable();
  }
};

class Position {
  constructor(line, character) {
    this.line = line;
    this.character = character;
  }
}

class Location {
  constructor(uri, position) {
    this.uri = uri;
    this.range = { start: position };
  }
}

class Breakpoint {
  constructor(enabled = true, condition, hitCondition, logMessage) {
    this.id = `breakpoint-${++breakpointId}`;
    this.enabled = enabled;
    this.condition = condition;
    this.hitCondition = hitCondition;
    this.logMessage = logMessage;
  }
}

class SourceBreakpoint extends Breakpoint {
  constructor(location, enabled, condition, hitCondition, logMessage) {
    super(enabled, condition, hitCondition, logMessage);
    this.location = location;
  }
}

class FunctionBreakpoint extends Breakpoint {
  constructor(functionName, enabled, condition, hitCondition, logMessage) {
    super(enabled, condition, hitCondition, logMessage);
    this.functionName = functionName;
  }
}

const vscode = {
  debug,
  Position,
  Location,
  SourceBreakpoint,
  FunctionBreakpoint,
  Uri: {
    file(file) {
      return {
        fsPath: file,
        toString() {
          return `file://${file.replace(/\\/g, "/")}`;
        }
      };
    }
  },
  workspace: {
    workspaceFolders: []
  }
};

const originalLoad = Module._load;
Module._load = function load(request) {
  if (request === "vscode") {
    return vscode;
  }
  return originalLoad.apply(this, arguments);
};
const { AgentDebugServer } = require("../out/server.js");
Module._load = originalLoad;

test.beforeEach(() => {
  debug.activeDebugSession = undefined;
  debug.breakpoints.splice(0);
});

test("tracks standard DAP state, current location, output, and signed thread ids", async () => {
  const requests = [];
  const session = createSession("session-1", async (request, args) => {
    requests.push({ request, args });
    if (request === "stackTrace") {
      return {
        stackFrames: [{
          id: -3,
          name: "Program.Main",
          source: { name: "Program.cs", path: "C:\\repo\\Program.cs" },
          line: 24,
          column: 9
        }]
      };
    }
    if (request === "continue") {
      return { allThreadsContinued: true };
    }
    return {};
  });
  const server = createServer();

  assert.equal(debug.trackerRegistration.debugType, "*");
  await server.handleAdapterMessage(session, {
    type: "event",
    event: "stopped",
    body: { reason: "breakpoint", threadId: -7, allThreadsStopped: true }
  });

  const paused = server.sessionRecords()[0];
  assert.equal(paused.state.status, "paused");
  assert.equal(paused.state.stopReason, "breakpoint");
  assert.equal(paused.state.activeThreadId, -7);
  assert.deepEqual(paused.state.location, {
    name: "Program.cs",
    path: "C:\\repo\\Program.cs",
    sourceReference: undefined,
    line: 24,
    column: 9
  });

  const control = await server.controlDebugging({ action: "continue", threadId: -7, sessionId: session.id });
  assert.equal(control.threadId, -7);
  assert.deepEqual(requests.at(-1), { request: "continue", args: { threadId: -7 } });

  await server.handleAdapterMessage(session, { type: "event", event: "continued", body: { threadId: -7 } });
  assert.equal(server.sessionRecords()[0].state.status, "running");

  for (let index = 0; index < 1_005; index += 1) {
    await server.handleAdapterMessage(session, {
      type: "event",
      event: "output",
      body: { category: "stdout", output: `line ${index}` }
    });
  }
  const recent = server.recentOutput({ tail: 2 });
  assert.equal(recent.totalCaptured, 1_000);
  assert.deepEqual(recent.output.map((entry) => entry.output), ["line 1003", "line 1004"]);
});

test("uses the first real source frame when an adapter pauses in external code", async () => {
  const session = createSession("session-external", async (request) => {
    if (request === "stackTrace") {
      return {
        stackFrames: [
          { id: 1, name: "Generated MoveNext", line: 47, column: 3 },
          { id: 2, name: "Program.Main", source: { name: "Program.cs", path: "C:\\repo\\Program.cs" }, line: 12, column: 5 }
        ]
      };
    }
    return {};
  });
  const server = createServer();

  await server.handleAdapterMessage(session, {
    type: "event",
    event: "stopped",
    body: { reason: "pause", threadId: 5, allThreadsStopped: true }
  });

  assert.deepEqual(server.sessionRecords()[0].state.location, {
    name: "Program.cs",
    path: "C:\\repo\\Program.cs",
    sourceReference: undefined,
    line: 12,
    column: 5
  });
});

test("uses native VS Code source breakpoints", async () => {
  const server = createServer();
  const file = path.resolve("src/Program.cs");
  const added = await server.addBreakpoint({ file, line: 17, condition: "count > 2" });

  assert.equal(debug.breakpoints.length, 1);
  assert.equal(debug.breakpoints[0] instanceof SourceBreakpoint, true);
  assert.equal(added.added.file, file);
  assert.equal(added.added.line, 17);
  assert.equal(added.added.condition, "count > 2");

  const removed = server.removeBreakpoint({ file, line: 17 });
  assert.equal(removed.removed.length, 1);
  assert.equal(debug.breakpoints.length, 0);
});

test("retains state and output only for the latest terminated sessions", async () => {
  const server = createServer();
  for (let index = 0; index < 21; index += 1) {
    const session = createSession(`session-${index}`);
    server.trackSession(session);
    await server.handleAdapterMessage(session, { type: "event", event: "output", body: { output: `${index}` } });
    server.markTerminated(session);
    server.sessions.delete(session.id);
  }

  assert.equal(server.terminatedSessions.size, 20);
  assert.equal(server.sessionStates.has("session-0"), false);
  assert.equal(server.outputBySession.has("session-0"), false);
  assert.equal(server.outputBySession.has("session-20"), true);
});

test("selects the newest matching run and the session with the latest output", async () => {
  const server = createServer();
  const first = createSession("first");
  const second = createSession("second");
  first.name = "Launch Program";
  second.name = "Launch Program";

  await server.handleAdapterMessage(first, { type: "event", event: "output", body: { output: "first" } });
  server.markTerminated(first);
  server.sessions.delete(first.id);
  await server.handleAdapterMessage(second, { type: "event", event: "output", body: { output: "second" } });
  server.markTerminated(second);
  server.sessions.delete(second.id);

  assert.equal(server.resolveOutputSessionId({ sessionName: "Launch Program" }), second.id);

  await server.handleAdapterMessage(first, { type: "event", event: "output", body: { output: "latest" } });
  server.sessions.delete(first.id);
  assert.equal(server.resolveOutputSessionId({}), first.id);
});

function createServer() {
  return new AgentDebugServer("127.0.0.1", "token", () => ({ id: "instance" }), () => false);
}

function createSession(id, customRequest = async () => ({})) {
  return {
    id,
    name: id,
    type: "mock",
    customRequest
  };
}

function disposableListener() {
  return disposable();
}

function disposable() {
  return { dispose() {} };
}
