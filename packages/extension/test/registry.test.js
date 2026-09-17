"use strict";

const assert = require("node:assert/strict");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { getRegistryDir } = require("../out/registry");

test("registry defaults to the user's home regardless of temporary-directory overrides", () => {
  assert.equal(getRegistryDir("", { TMPDIR: "/different-temp" }), path.join(os.homedir(), ".agent-debug-relay", "instances"));
});

test("VS Code settings override launcher environment, which overrides the default", () => {
  const env = { AGENT_DEBUG_RELAY_REGISTRY_DIR: "launcher-registry", VSCODE_AGENT_DEBUG_REGISTRY_DIR: "legacy-registry" };
  assert.equal(getRegistryDir("configured-registry", env), path.resolve("configured-registry"));
  assert.equal(getRegistryDir("", env), path.resolve("launcher-registry"));
  assert.equal(getRegistryDir("", { VSCODE_AGENT_DEBUG_REGISTRY_DIR: "legacy-registry" }), path.resolve("legacy-registry"));
});
