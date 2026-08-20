export const PROTOCOL_VERSION = 3;

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
  "sessionState"
] as const;
