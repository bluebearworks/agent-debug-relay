#!/usr/bin/env node
"use strict";

const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");

const DEFAULT_REGISTRY_DIR = path.join(os.tmpdir(), "agent-debug-relay", "instances");
const LEGACY_REGISTRY_DIR = path.join(os.tmpdir(), "vscode-agent-debug", "instances");
const REQUIRED_PROTOCOL_VERSION = 2;

const COMMAND_CAPABILITIES = {
  profiles: ["profileLifecycleFields"],
  sessions: ["sessions"],
  stop: ["stop", "stopPolling"],
  restart: ["restart", "stopPolling"]
};

main().catch((error) => {
  console.error(error.message || String(error));
  process.exitCode = 1;
});

async function main() {
  const { command, positional, options } = parseArgs(process.argv.slice(2));

  if (options.help || !command) {
    printHelp();
    return;
  }

  const registryDirs = registryDirectories(options);
  const instances = registryDirs.flatMap((registryDir) => discoverInstances(registryDir)).filter((instance) => instance.live);

  if (command === "instances") {
    output(options, instances.map((entry) => entry.record));
    return;
  }

  const selected = selectInstance(instances, options);
  ensureCompatible(selected.record, COMMAND_CAPABILITIES[command] || []);

  if (command === "status") {
    const status = await requestJson(selected.record, "GET", "/health");
    output(options, status);
    return;
  }

  if (command === "profiles") {
    const profiles = await requestJson(selected.record, "GET", "/launch-profiles");
    output(options, profiles);
    return;
  }

  if (command === "sessions") {
    const sessions = await requestJson(selected.record, "GET", "/debug-sessions");
    output(options, sessions);
    return;
  }

  if (command === "start") {
    const profileName = positional.join(" ").trim() || options.name || options.profileName;

    if (!profileName) {
      throw new Error("profile name is required");
    }

    const profiles = await requestJson(selected.record, "GET", "/launch-profiles");
    const profile = chooseProfile(profiles.profiles || [], profileName, options);
    const result = await requestJson(selected.record, "POST", "/debug-sessions", {
      profileName: profile.name,
      folderUri: profile.folderUri,
      noDebug: options.noDebug ? true : undefined
    });

    output(options, result);
    return;
  }

  if (command === "stop") {
    const session = positional.join(" ").trim() || options.session || options.sessionName || options.sessionId;
    const result = await requestJson(selected.record, "POST", "/debug-sessions/stop", {
      all: options.all ? true : undefined,
      session: session || undefined,
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      waitMs: numberOption(options.waitMs, "wait-ms")
    });

    output(options, result);
    return;
  }

  if (command === "restart") {
    const profileName = positional.join(" ").trim() || options.name || options.profileName;

    if (!profileName) {
      throw new Error("profile name is required");
    }

    const profiles = await requestJson(selected.record, "GET", "/launch-profiles");
    const profile = chooseProfile(profiles.profiles || [], profileName, options);
    const result = await requestJson(selected.record, "POST", "/debug-sessions/restart", {
      profileName: profile.name,
      folderUri: profile.folderUri,
      noDebug: options.noDebug ? true : undefined,
      all: options.all ? true : undefined,
      session: options.session,
      sessionId: options.sessionId,
      sessionName: options.sessionName,
      waitMs: numberOption(options.waitMs, "wait-ms")
    });

    output(options, result);
    return;
  }

  throw new Error(`unknown command: ${command}`);
}

function parseArgs(args) {
  const options = {};
  const positional = [];
  let command;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const normalized = key.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
      const next = args[index + 1];

      if (["json", "help", "no-debug", "all"].includes(key)) {
        options[normalized] = true;
      } else {
        if (!next) {
          throw new Error(`missing value for ${arg}`);
        }

        options[normalized] = next;
        index += 1;
      }
    } else if (!command) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, positional, options };
}

function discoverInstances(registryDir) {
  if (!fs.existsSync(registryDir)) {
    return [];
  }

  return fs.readdirSync(registryDir, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
    .map((entry) => path.join(registryDir, entry.name))
    .map((file) => readInstance(file))
    .filter(Boolean)
    .map((record) => ({
      record,
      live: isLiveProcess(record.pid),
      ageMs: Date.now() - Date.parse(record.updatedAt || 0)
    }))
    .sort((left, right) => Date.parse(right.record.updatedAt || 0) - Date.parse(left.record.updatedAt || 0));
}

function readInstance(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

function isLiveProcess(pid) {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function selectInstance(instances, options) {
  if (instances.length === 0) {
    throw new Error("no running VS Code instances with Agent Debug Relay were found");
  }

  if (options.instance) {
    const exact = instances.find((entry) => entry.record.id === options.instance);

    if (!exact) {
      throw new Error(`instance not found: ${options.instance}`);
    }

    return exact;
  }

  const workspace = path.resolve(options.workspace || process.cwd());
  const scored = instances
    .map((entry) => ({ entry, score: instanceScore(entry.record, workspace) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score);

  if (scored.length > 0) {
    return scored[0].entry;
  }

  if (instances.length === 1) {
    return instances[0];
  }

  const candidates = instances.map((entry) => {
    const folders = (entry.record.workspaceFolders || []).map((folder) => folder.path).join(", ");
    return `- ${entry.record.id}: ${folders || entry.record.workspaceFile || "(empty workspace)"}`;
  }).join("\n");

  throw new Error(`multiple VS Code instances are running; pass --workspace or --instance\n${candidates}`);
}

function ensureCompatible(record, requiredCapabilities) {
  if (requiredCapabilities.length === 0) {
    return;
  }

  const protocolVersion = Number.isInteger(record.protocolVersion) ? record.protocolVersion : 1;
  const capabilities = Array.isArray(record.capabilities) ? record.capabilities : [];

  if (protocolVersion < REQUIRED_PROTOCOL_VERSION) {
    throw new Error(`VS Code window ${record.id} is running Agent Debug Relay protocol ${protocolVersion}; reload that VS Code window so it picks up protocol ${REQUIRED_PROTOCOL_VERSION}.`);
  }

  const missing = requiredCapabilities.filter((capability) => !capabilities.includes(capability));
  if (missing.length > 0) {
    throw new Error(`VS Code window ${record.id} is missing capabilities: ${missing.join(", ")}. Reload the window or reinstall the extension.`);
  }
}

function instanceScore(record, workspace) {
  const target = normalizePath(workspace);
  let score = 0;

  for (const folder of record.workspaceFolders || []) {
    const folderPath = normalizePath(folder.path);

    if (target === folderPath || target.startsWith(folderPath + path.sep)) {
      score = Math.max(score, folderPath.length);
    }
  }

  if (record.workspaceFile && normalizePath(record.workspaceFile) === target) {
    score = Math.max(score, 10_000);
  }

  if (score > 0 && record.focused) {
    score += 100_000;
  }

  return score;
}

function normalizePath(value) {
  return path.resolve(value).toLowerCase();
}

function chooseProfile(profiles, profileName, options) {
  let matches = profiles.filter((profile) => profile.name === profileName);

  if (options.folder) {
    const folderNeedle = normalizeLoose(options.folder);
    matches = matches.filter((profile) => {
      return [profile.folderUri, profile.folderPath, profile.folderName]
        .filter(Boolean)
        .some((value) => normalizeLoose(value) === folderNeedle);
    });
  }

  if (matches.length === 1) {
    return matches[0];
  }

  if (matches.length === 0) {
    throw new Error(`launch profile not found: ${profileName}`);
  }

  const candidates = matches.map((profile) => {
    return `- ${profile.name} (${profile.folderName || "workspace"}: ${profile.folderPath || profile.folderUri || "no folder"})`;
  }).join("\n");

  throw new Error(`multiple launch profiles named ${profileName}; pass --folder\n${candidates}`);
}

function normalizeLoose(value) {
  return String(value).replace(/\\/g, "/").toLowerCase();
}

function requestJson(record, method, route, body) {
  const payload = body ? JSON.stringify(dropUndefined(body)) : undefined;

  return new Promise((resolve, reject) => {
    const request = http.request({
      hostname: record.host,
      port: record.port,
      path: route,
      method,
      headers: {
        authorization: `Bearer ${record.token}`,
        "content-type": "application/json",
        "content-length": payload ? Buffer.byteLength(payload) : 0
      }
    }, (response) => {
      const chunks = [];

      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        let parsed;

        try {
          parsed = raw ? JSON.parse(raw) : {};
        } catch {
          reject(new Error(raw || `HTTP ${response.statusCode}`));
          return;
        }

        if (response.statusCode && response.statusCode >= 400) {
          reject(new Error(parsed.error || `HTTP ${response.statusCode}`));
          return;
        }

        resolve(parsed);
      });
    });

    request.on("error", reject);

    if (payload) {
      request.write(payload);
    }

    request.end();
  });
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entryValue]) => entryValue !== undefined));
}

function output(options, value) {
  if (options.json) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      printInstance(item);
    }
    return;
  }

  if (value && Array.isArray(value.profiles)) {
    for (const profile of value.profiles) {
      console.log(`${profile.name}\t${profile.kind}\t${profile.folderPath || profile.folderName || "workspace"}`);
    }
    return;
  }

  if (value && Array.isArray(value.sessions)) {
    printSessions(value);
    return;
  }

  console.log(JSON.stringify(value, null, 2));
}

function printInstance(record) {
  const folders = (record.workspaceFolders || []).map((folder) => folder.path).join(", ");
  const protocol = record.protocolVersion ? `protocol ${record.protocolVersion}` : "protocol 1";
  const version = record.extensionVersion ? `extension ${record.extensionVersion}` : "extension unknown";
  console.log(`${record.id}\t${record.host}:${record.port}\t${record.focused ? "focused" : "background"}\t${protocol}\t${version}\t${folders || record.workspaceFile || "(empty workspace)"}`);
}

function printSessions(value) {
  const activeId = value.active?.id;
  for (const session of value.sessions) {
    console.log(`${session.id}\t${session.id === activeId ? "active" : "background"}\t${session.name}\t${session.type}\t${session.workspaceFolder || "workspace"}`);
  }
}

function printHelp() {
  console.log(`agent-debug-relay

Usage:
  agent-debug-relay instances [--workspace <path>] [--json]
  agent-debug-relay profiles [--workspace <path>] [--instance <id>] [--json]
  agent-debug-relay sessions [--workspace <path>] [--instance <id>] [--json]
  agent-debug-relay start <profile name> [--workspace <path>] [--folder <folder>] [--instance <id>] [--no-debug] [--json]
  agent-debug-relay stop [session id or name] [--workspace <path>] [--instance <id>] [--all] [--wait-ms <ms>] [--json]
  agent-debug-relay restart <profile name> [--workspace <path>] [--folder <folder>] [--instance <id>] [--session <id or name>] [--all] [--wait-ms <ms>] [--no-debug] [--json]
  agent-debug-relay status [--workspace <path>] [--instance <id>] [--json]

Options:
  --workspace <path>      Select the VS Code window whose workspace contains this path.
  --instance <id>         Select a specific registered VS Code window.
  --folder <folder>       Disambiguate duplicate profile names in multi-root workspaces.
  --session <id or name>   Select a debug session to stop before restart.
  --all                   Stop all debug sessions in the selected VS Code window.
  --wait-ms <ms>           Wait this long for stopped sessions to terminate. Defaults to 15000.
  --no-debug              Start without attaching a debugger.
  --registry-dir <path>   Read instance records from a custom registry directory.
  --json                  Print machine-readable JSON.
`);
}

function registryDirectories(options) {
  const configured = options.registryDir || process.env.AGENT_DEBUG_RELAY_REGISTRY_DIR || process.env.VSCODE_AGENT_DEBUG_REGISTRY_DIR;

  if (configured) {
    return [configured];
  }

  return [DEFAULT_REGISTRY_DIR, LEGACY_REGISTRY_DIR];
}

function numberOption(value, label) {
  if (value === undefined) {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`--${label} must be a non-negative number`);
  }

  return parsed;
}
