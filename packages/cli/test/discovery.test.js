"use strict";

const assert = require("node:assert/strict");
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const test = require("node:test");
const { discoverInstances, parseArgs, registryDirectories } = require("../bin/agent-debug-relay");

const exec = promisify(execFile);
const cli = path.resolve(__dirname, "../bin/agent-debug-relay.js");

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "relay-discovery-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function record(directory) {
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, "test.json"), JSON.stringify({
    id: "discovery-test", pid: process.pid, updatedAt: new Date().toISOString()
  }));
}

test("registry flags accept separate and equals values and take precedence", () => {
  for (const args of [
    ["instances", "--registry-dir", "/custom registry"],
    ["--registry-dir=/custom registry", "instances"]
  ]) {
    const parsed = parseArgs(args);
    assert.equal(parsed.command, "instances");
    assert.deepEqual(registryDirectories(parsed.options), ["/custom registry"]);
  }
  assert.throws(() => parseArgs(["instances", "--registry-dir", "--json"]), /missing value/);
  assert.throws(() => parseArgs(["instances", "--registry-dir="]), /missing value/);
});

test("default discovery survives different temp directories between processes", async (t) => {
  const directory = fixture(t);
  record(path.join(directory, ".agent-debug-relay", "instances"));
  for (const temporary of ["vscode-temp", "agent-temp"]) {
    const env = { ...process.env, HOME: directory, USERPROFILE: directory,
      TMPDIR: path.join(directory, temporary), TMP: path.join(directory, temporary), TEMP: path.join(directory, temporary) };
    delete env.AGENT_DEBUG_RELAY_REGISTRY_DIR;
    delete env.VSCODE_AGENT_DEBUG_REGISTRY_DIR;
    const { stdout } = await exec(process.execPath, [cli, "instances", "--json"], { env });
    assert.equal(JSON.parse(stdout)[0].id, "discovery-test");
  }
});

test("environment override and legacy temp records remain discoverable", async (t) => {
  const directory = fixture(t);
  const custom = path.join(directory, "custom");
  record(custom);
  const env = { ...process.env, HOME: directory, USERPROFILE: directory,
    TMPDIR: directory, TMP: directory, TEMP: directory };
  delete env.AGENT_DEBUG_RELAY_REGISTRY_DIR;
  delete env.VSCODE_AGENT_DEBUG_REGISTRY_DIR;
  const overridden = await exec(process.execPath, [cli, "instances", "--json"], {
    env: { ...env, AGENT_DEBUG_RELAY_REGISTRY_DIR: custom }
  });
  assert.equal(JSON.parse(overridden.stdout)[0].id, "discovery-test");
  record(path.join(directory, "agent-debug-relay", "instances"));
  record(path.join(directory, "vscode-agent-debug", "instances"));
  const legacy = await exec(process.execPath, [cli, "instances", "--json"], { env });
  assert.equal(JSON.parse(legacy.stdout).length, 1);
});

test("permission-denied process probes retain records; missing processes are excluded", (t) => {
  const directory = fixture(t);
  record(directory);
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  for (const code of ["EPERM", "EACCES", "ESRCH"]) {
    const probe = t.mock.method(process, "kill", () => { throw Object.assign(new Error(code), { code }); });
    assert.equal(discoverInstances(directory)[0].live, code !== "ESRCH");
    probe.mock.restore();
  }
  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /Permission denied.*retaining the instance/);
});

test("unreadable directories and records produce actionable diagnostics", (t) => {
  const warnings = [];
  t.mock.method(console, "error", (message) => warnings.push(message));
  const denied = () => { throw Object.assign(new Error("denied"), { code: "EACCES" }); };
  const directoryRead = t.mock.method(fs, "readdirSync", denied);
  assert.deepEqual(discoverInstances("/denied"), []);
  directoryRead.mock.restore();
  const directory = fixture(t);
  record(directory);
  t.mock.method(fs, "readFileSync", denied);
  assert.deepEqual(discoverInstances(directory), []);
  assert.match(warnings[0], /Cannot read relay registry.*EACCES/);
  assert.match(warnings[1], /Cannot read relay record.*EACCES/);
});

test("empty discovery keeps JSON clean and reports the searched directory on stderr", async (t) => {
  const directory = fixture(t);
  const { stdout, stderr } = await exec(process.execPath, [cli, "instances", "--json", `--registry-dir=${directory}`]);
  assert.deepEqual(JSON.parse(stdout), []);
  assert.ok(stderr.includes(directory));
});

test("macOS sandbox denying process signals still discovers VS Code records", { skip: process.platform !== "darwin" }, async (t) => {
  const directory = fixture(t);
  record(directory);
  const { stdout, stderr } = await exec("/usr/bin/sandbox-exec", [
    "-p", "(version 1)(allow default)(deny signal)",
    process.execPath, cli, "instances", "--json", "--registry-dir", directory
  ]);
  assert.equal(JSON.parse(stdout)[0].id, "discovery-test");
  assert.match(stderr, /Permission denied checking relay process/);
});
