"use strict";

const assert = require("node:assert/strict");
const Module = require("node:module");
const path = require("node:path");
const test = require("node:test");

let breakpointId = 0;
const terminalListeners = {
  open: [],
  close: [],
  start: [],
  end: []
};
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
  },
  window: {
    terminals: [],
    activeTerminal: undefined,
    onDidOpenTerminal: terminalEvent("open"),
    onDidCloseTerminal: terminalEvent("close"),
    onDidStartTerminalShellExecution: terminalEvent("start"),
    onDidEndTerminalShellExecution: terminalEvent("end"),
    createTerminal(options) {
      const terminal = createTerminal(options.name, options.cwd?.fsPath);
      this.terminals.push(terminal);
      this.activeTerminal = terminal;
      fireTerminalEvent("open", terminal);
      return terminal;
    }
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
  vscode.window.terminals.splice(0);
  vscode.window.activeTerminal = undefined;
  for (const listeners of Object.values(terminalListeners)) {
    listeners.splice(0);
  }
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

test("runs, captures, writes to, interrupts, waits for, lists, and stops a visible integrated terminal", async () => {
  const server = createServer();
  const started = await server.runTerminalCommand({
    command: "npm start",
    name: "dev server",
    cwd: "C:\\repo"
  });
  const terminal = vscode.window.terminals[0];

  assert.equal(started.started, true);
  assert.equal(started.created, true);
  assert.equal(started.outputCapture, true);
  assert.equal(started.terminal.name, "dev server");
  assert.equal(terminal.shown, true);
  assert.deepEqual(terminal.commands, ["npm start"]);

  await new Promise((resolve) => setImmediate(resolve));
  const output = server.recentTerminalOutput({ terminalId: started.terminal.id, tail: 1 });
  assert.equal(output.totalCaptured, 2);
  assert.equal(output.output[0].output, "ready\r\n");

  const input = await server.sendTerminalInput({
    terminalId: started.terminal.id,
    input: "r",
    addNewLine: false
  });
  assert.equal(input.sent, true);
  assert.deepEqual(terminal.sentText, [{ text: "r", addNewLine: false }]);

  const interrupted = await server.interruptTerminal({ terminalId: started.terminal.id });
  assert.equal(interrupted.interrupted, true);
  assert.deepEqual(terminal.sentText.at(-1), { text: "\x03", addNewLine: false });

  setTimeout(() => fireTerminalEvent("end", {
    terminal,
    execution: terminal.executions[0],
    exitCode: 130
  }), 10);
  const waited = await server.waitForTerminal({ terminalId: started.terminal.id, waitMs: 1000 });
  assert.equal(waited.completed, true);
  assert.equal(waited.terminal.status, "exited");
  assert.equal(waited.terminal.exitCode, 130);

  const listed = await server.terminalRecords();
  assert.equal(listed.activeTerminalId, started.terminal.id);
  assert.equal(listed.terminals[0].status, "exited");
  assert.equal(listed.terminals[0].managed, true);

  const stopped = await server.stopTerminal({ terminalId: started.terminal.id });
  assert.equal(stopped.stopped, true);
  assert.equal(terminal.disposed, true);
  assert.equal(server.terminals.size, 0);
  assert.equal(server.terminalStates.get(started.terminal.id).status, "closed");
});

test("run can wait for completion and terminal wait reports a timeout without closing the terminal", async () => {
  const server = createServer();
  const running = server.runTerminalCommand({ command: "npm test", wait: true, waitMs: 1000 });
  await new Promise((resolve) => setImmediate(resolve));
  const terminal = vscode.window.terminals[0];
  fireTerminalEvent("end", { terminal, execution: terminal.executions[0], exitCode: 0 });

  const result = await running;
  assert.equal(result.wait.completed, true);
  assert.equal(result.wait.terminal.exitCode, 0);

  terminal.shellIntegration.executeCommand("npm run watch");
  await new Promise((resolve) => setImmediate(resolve));
  const timedOut = await server.waitForTerminal({ terminalId: result.terminal.id, waitMs: 0 });
  assert.equal(timedOut.completed, false);
  assert.equal(timedOut.terminal.status, "running");
  assert.equal(terminal.disposed, false);
});

test("wait follows the requested shell execution when a stale command ends later", async () => {
  const server = createServer();
  const first = await server.runTerminalCommand({ command: "first" });
  const terminal = vscode.window.terminals[0];
  const firstExecution = terminal.executions[0];

  let settled = false;
  const secondRun = server.runTerminalCommand({
    terminalId: first.terminal.id,
    command: "second",
    wait: true,
    waitMs: 1000
  }).then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setImmediate(resolve));
  const secondExecution = terminal.executions[1];

  fireTerminalEvent("end", { terminal, execution: firstExecution, exitCode: 9 });
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(settled, false);
  assert.equal(server.terminalStates.get(first.terminal.id).status, "running");

  fireTerminalEvent("end", { terminal, execution: secondExecution, exitCode: 0 });
  const result = await secondRun;
  assert.equal(result.wait.completed, true);
  assert.equal(result.wait.execution.command, "second");
  assert.equal(result.wait.execution.exitCode, 0);
  assert.equal(result.wait.terminal.exitCode, 0);
});

test("falls back to sendText and reports unknown execution state without shell integration", async () => {
  const server = createServer();
  server.waitForShellIntegration = async () => undefined;
  const originalCreateTerminal = vscode.window.createTerminal;
  vscode.window.createTerminal = function createTerminalWithoutIntegration(options) {
    const terminal = createTerminal(options.name, options.cwd?.fsPath);
    terminal.shellIntegration = undefined;
    this.terminals.push(terminal);
    this.activeTerminal = terminal;
    fireTerminalEvent("open", terminal);
    return terminal;
  };

  try {
    const started = await server.runTerminalCommand({ command: "npm start" });
    const terminal = vscode.window.terminals[0];
    assert.equal(started.outputCapture, false);
    assert.equal(started.terminal.status, "unknown");
    assert.deepEqual(terminal.sentText, [{ text: "npm start", addNewLine: true }]);

    const waited = await server.runTerminalCommand({
      command: "npm test",
      terminalId: started.terminal.id,
      wait: true,
      waitMs: 1000
    });
    assert.equal(waited.wait.completed, false);
    assert.equal(waited.wait.unavailable, true);
    assert.equal(waited.wait.reason, "shellIntegrationUnavailable");
    assert.equal(waited.wait.terminal.id, started.terminal.id);
    assert.deepEqual(terminal.sentText.at(-1), { text: "npm test", addNewLine: true });
  } finally {
    vscode.window.createTerminal = originalCreateTerminal;
  }
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

function createTerminal(name = "PowerShell", cwd = "C:\\repo") {
  const terminal = {
    name,
    processId: Promise.resolve(4321),
    commands: [],
    executions: [],
    sentText: [],
    shown: false,
    disposed: false,
    shellIntegration: {
      cwd: { fsPath: cwd },
      executeCommand(command) {
        terminal.commands.push(command);
        const execution = {
          commandLine: { value: command },
          cwd: { fsPath: cwd },
          async *read() {
            yield "starting\r\n";
            yield "ready\r\n";
          }
        };
        terminal.executions.push(execution);
        queueMicrotask(() => fireTerminalEvent("start", { terminal, execution }));
        return execution;
      }
    },
    show() {
      this.shown = true;
      vscode.window.activeTerminal = this;
    },
    sendText(text, addNewLine) {
      this.sentText.push({ text, addNewLine });
    },
    dispose() {
      this.disposed = true;
      vscode.window.terminals.splice(0, vscode.window.terminals.length, ...vscode.window.terminals.filter((item) => item !== this));
      if (vscode.window.activeTerminal === this) {
        vscode.window.activeTerminal = undefined;
      }
      fireTerminalEvent("close", this);
    }
  };
  return terminal;
}

function terminalEvent(kind) {
  return (listener) => {
    terminalListeners[kind].push(listener);
    return {
      dispose() {
        const index = terminalListeners[kind].indexOf(listener);
        if (index >= 0) {
          terminalListeners[kind].splice(index, 1);
        }
      }
    };
  };
}

function fireTerminalEvent(kind, event) {
  for (const listener of [...terminalListeners[kind]]) {
    listener(event);
  }
}

function disposableListener() {
  return disposable();
}

function disposable() {
  return { dispose() {} };
}
