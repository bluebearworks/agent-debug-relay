"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");

const execFileAsync = promisify(execFile);
const cliPath = path.resolve(__dirname, "../bin/agent-debug-relay.js");
const repoPath = path.resolve(__dirname, "../../..");

test("help documents the interactive debugger commands", async () => {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, "--help"]);
  assert.match(stdout, /breakpoint add <file>:<line>/);
  assert.match(stdout, /pause\|continue\|step-over\|step-in\|step-out/);
  assert.match(stdout, /variables <variablesReference>/);
  assert.match(stdout, /output \[--tail <count>\|--count <count>\]/);
});

test("breakpoint add sends an absolute source location and condition", async (t) => {
  const relay = await createRelay(t);
  const response = await runJson([
    "breakpoint", "add", "src/example.ts:27",
    "--condition", "value > 10",
    ...relay.targetArgs
  ]);

  assert.equal(response.method, "POST");
  assert.equal(response.url, "/breakpoints");
  assert.equal(response.authorization, "Bearer test-token");
  assert.deepEqual(response.body, {
    file: path.resolve(repoPath, "src/example.ts"),
    line: 27,
    condition: "value > 10"
  });
});

test("execution and inspection commands preserve debugger selectors", async (t) => {
  const relay = await createRelay(t);
  const step = await runJson([
    "step-over", "--session", "debug-1", "--thread-id", "7", ...relay.targetArgs
  ]);
  assert.equal(step.url, "/debug-sessions/control");
  assert.deepEqual(step.body, { session: "debug-1", action: "step-over", threadId: 7 });

  const variables = await runJson([
    "variables", "42", "--filter", "indexed", "--start", "5", "--count", "10",
    "--session-id", "debug-1", ...relay.targetArgs
  ]);
  assert.equal(variables.url, "/debug-sessions/variables");
  assert.deepEqual(variables.body, {
    sessionId: "debug-1",
    variablesReference: 42,
    filter: "indexed",
    start: 5,
    count: 10
  });
});

test("eval keeps the complete expression and output accepts count as a tail alias", async (t) => {
  const relay = await createRelay(t);
  const evaluation = await runJson([
    "eval", "customer.Total", "+", "tax", "--frame-id", "12", ...relay.targetArgs
  ]);
  assert.equal(evaluation.url, "/debug-sessions/evaluate");
  assert.equal(evaluation.body.expression, "customer.Total + tax");
  assert.equal(evaluation.body.frameId, 12);

  const output = await runJson(["output", "--count", "25", ...relay.targetArgs]);
  assert.equal(output.url, "/debug-sessions/output");
  assert.equal(output.body.tail, 25);
});

test("status uses the authenticated session-state endpoint when advertised", async (t) => {
  const relay = await createRelay(t, ["sessionState"]);
  const status = await runJson(["status", ...relay.targetArgs]);
  assert.equal(status.method, "GET");
  assert.equal(status.url, "/status");

  const text = await runText(["status", ...relay.targetArgs]);
  assert.match(text, /"ok": true/);
  assert.match(text, /"sessions": \[\]/);
});

async function runJson(args) {
  const stdout = await runText([...args, "--json"]);
  return JSON.parse(stdout);
}

async function runText(args) {
  const { stdout } = await execFileAsync(process.execPath, [cliPath, ...args], { cwd: repoPath });
  return stdout;
}

async function createRelay(t, extraCapabilities = []) {
  const registryDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-debug-relay-test-"));
  const token = "test-token";
  const server = http.createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }
    const raw = Buffer.concat(chunks).toString("utf8");
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      method: request.method,
      url: request.url,
      authorization: request.headers.authorization,
      ok: request.url === "/status" ? true : undefined,
      sessions: request.url === "/status" ? [] : undefined,
      body: raw ? JSON.parse(raw) : undefined
    }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");

  await fs.writeFile(path.join(registryDir, "test-instance.json"), JSON.stringify({
    id: "test-instance",
    extensionVersion: "0.2.0",
    protocolVersion: 3,
    capabilities: ["breakpoints", "executionControl", "inspection", "debugOutput", ...extraCapabilities],
    pid: process.pid,
    host: "127.0.0.1",
    port: address.port,
    token,
    updatedAt: new Date().toISOString(),
    workspaceFolders: [{ path: repoPath }]
  }));

  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(registryDir, { recursive: true, force: true });
  });

  return {
    targetArgs: ["--instance", "test-instance", "--registry-dir", registryDir]
  };
}
