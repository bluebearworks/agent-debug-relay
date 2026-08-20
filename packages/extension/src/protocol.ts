export const PROTOCOL_VERSION = 4;

export const CAPABILITIES = [
  "profiles",
  "profileLifecycleFields",
  "sessions",
  "stop",
  "restart",
  "stopPolling",
  "breakpoints",
  "executionControl",
  "inspection",
  "debugOutput",
  "sessionState",
  "terminals"
] as const;
