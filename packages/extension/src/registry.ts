import * as os from "os";
import * as path from "path";

export function getRegistryDir(configured: string, env: NodeJS.ProcessEnv = process.env): string {
  const directory = configured.trim() || env.AGENT_DEBUG_RELAY_REGISTRY_DIR || env.VSCODE_AGENT_DEBUG_REGISTRY_DIR;
  return directory
    ? path.resolve(directory)
    : path.join(os.homedir(), ".agent-debug-relay", "instances");
}
