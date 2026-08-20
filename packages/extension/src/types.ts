export type WorkspaceFolderRecord = {
  name: string;
  uri: string;
  path: string;
  index: number;
};

export type ActiveEditorRecord = {
  uri: string;
  path: string;
  languageId: string;
} | undefined;

export type InstanceRecord = {
  id: string;
  extensionVersion: string;
  protocolVersion: number;
  capabilities: string[];
  pid: number;
  appName: string;
  appHost: string;
  remoteName: string | undefined;
  machineId: string;
  sessionId: string;
  host: string;
  port: number;
  token: string;
  registryPath: string;
  workspaceFile: string | undefined;
  workspaceFolders: WorkspaceFolderRecord[];
  activeEditor: ActiveEditorRecord;
  focused: boolean;
  activeDebugSession: {
    id: string;
    name: string;
    type: string;
  } | undefined;
  createdAt: string;
  updatedAt: string;
};

export type DebugSourceLocation = {
  name?: string;
  path?: string;
  sourceReference?: number;
  line: number;
  column?: number;
};

export type DebugSessionState = {
  status: "running" | "paused" | "terminated";
  stopReason?: string;
  stopDescription?: string;
  activeThreadId?: number;
  allThreadsStopped?: boolean;
  location?: DebugSourceLocation;
  lastEventAt: string;
};

export type LaunchProfileRecord = {
  kind: "configuration" | "compound" | "dotnetLaunchSettings";
  name: string;
  folderName: string | undefined;
  folderUri: string | undefined;
  folderPath: string | undefined;
  projectName?: string;
  projectPath?: string;
  launchSettingsPath?: string;
  launchSettingsProfile?: string;
  type: string | undefined;
  request: string | undefined;
  preLaunchTask: string | undefined;
  postDebugTask: string | undefined;
  detail: unknown;
};
