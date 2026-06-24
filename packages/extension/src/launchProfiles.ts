import * as vscode from "vscode";
import { LaunchProfileRecord } from "./types";

type LaunchConfiguration = {
  name?: unknown;
  type?: unknown;
  request?: unknown;
  preLaunchTask?: unknown;
  postDebugTask?: unknown;
  [key: string]: unknown;
};

type LaunchCompound = {
  name?: unknown;
  configurations?: unknown;
  preLaunchTask?: unknown;
  postDebugTask?: unknown;
  [key: string]: unknown;
};

type DotnetLaunchSettings = {
  profiles?: unknown;
  [key: string]: unknown;
};

type DotnetLaunchSettingsProfile = {
  commandName?: unknown;
  [key: string]: unknown;
};

export async function getLaunchProfiles(): Promise<LaunchProfileRecord[]> {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    return getProfilesForScope(undefined);
  }

  const launchJsonProfiles = folders.flatMap((folder) => getProfilesForScope(folder));
  const dotnetProfiles = await getDotnetLaunchSettingsProfiles();

  return [...launchJsonProfiles, ...dotnetProfiles];
}

function getProfilesForScope(folder: vscode.WorkspaceFolder | undefined): LaunchProfileRecord[] {
  const scope = folder?.uri;
  const launchConfig = vscode.workspace.getConfiguration("launch", scope);
  const configurations = launchConfig.get<LaunchConfiguration[]>("configurations") ?? [];
  const compounds = launchConfig.get<LaunchCompound[]>("compounds") ?? [];

  const folderName = folder?.name;
  const folderUri = folder?.uri.toString();
  const folderPath = folder?.uri.fsPath;

  const configProfiles = configurations
    .filter((configuration) => typeof configuration.name === "string")
    .map((configuration) => ({
      kind: "configuration" as const,
      name: configuration.name as string,
      folderName,
      folderUri,
      folderPath,
      type: stringField(configuration.type),
      request: stringField(configuration.request),
      preLaunchTask: stringField(configuration.preLaunchTask),
      postDebugTask: stringField(configuration.postDebugTask),
      detail: cloneJson(configuration)
    }));

  const compoundProfiles = compounds
    .filter((compound) => typeof compound.name === "string")
    .map((compound) => ({
      kind: "compound" as const,
      name: compound.name as string,
      folderName,
      folderUri,
      folderPath,
      type: undefined,
      request: undefined,
      preLaunchTask: stringField(compound.preLaunchTask),
      postDebugTask: stringField(compound.postDebugTask),
      detail: cloneJson(compound)
    }));

  return [...configProfiles, ...compoundProfiles];
}

async function getDotnetLaunchSettingsProfiles(): Promise<LaunchProfileRecord[]> {
  const launchSettingsUris = await vscode.workspace.findFiles("**/Properties/launchSettings.json", "**/{bin,obj,node_modules}/**");
  const allProfiles = await Promise.all(launchSettingsUris.map((uri) => getDotnetProfilesForLaunchSettings(uri)));

  return allProfiles.flat();
}

async function getDotnetProfilesForLaunchSettings(launchSettingsUri: vscode.Uri): Promise<LaunchProfileRecord[]> {
  const projectDirectory = vscode.Uri.joinPath(launchSettingsUri, "..", "..");
  const projectUri = await findProjectFile(projectDirectory);

  if (!projectUri) {
    return [];
  }

  const launchSettings = await readLaunchSettings(launchSettingsUri);

  if (!launchSettings || !isObject(launchSettings.profiles)) {
    return [];
  }

  const workspaceFolder = vscode.workspace.getWorkspaceFolder(projectDirectory);
  const projectName = fileNameWithoutExtension(projectUri);
  const projectPath = projectUri.fsPath;
  const launchSettingsPath = launchSettingsUri.fsPath;

  return Object.entries(launchSettings.profiles)
    .filter((entry): entry is [string, DotnetLaunchSettingsProfile] => typeof entry[0] === "string" && isObject(entry[1]))
    .map(([profileName, profile]) => ({
      kind: "dotnetLaunchSettings" as const,
      name: profileName,
      folderName: workspaceFolder?.name,
      folderUri: workspaceFolder?.uri.toString(),
      folderPath: workspaceFolder?.uri.fsPath,
      projectName,
      projectPath,
      launchSettingsPath,
      launchSettingsProfile: profileName,
      type: "dotnet",
      request: "launch",
      preLaunchTask: undefined,
      postDebugTask: undefined,
      detail: {
        profileName,
        commandName: stringField(profile.commandName),
        projectPath,
        launchSettingsPath,
        profile: cloneJson(profile)
      }
    }));
}

async function findProjectFile(projectDirectory: vscode.Uri): Promise<vscode.Uri | undefined> {
  let entries: [string, vscode.FileType][];

  try {
    entries = await vscode.workspace.fs.readDirectory(projectDirectory);
  } catch {
    entries = [];
  }

  const projectFile = entries
    .filter(([name, type]) => type === vscode.FileType.File && name.toLowerCase().endsWith(".csproj"))
    .map(([name]) => name)
    .sort((left, right) => left.localeCompare(right))[0];

  return projectFile ? vscode.Uri.joinPath(projectDirectory, projectFile) : undefined;
}

async function readLaunchSettings(uri: vscode.Uri): Promise<DotnetLaunchSettings | undefined> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(text) as unknown;

    return isObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fileNameWithoutExtension(uri: vscode.Uri): string {
  const fileName = uri.path.split("/").pop() ?? uri.fsPath;
  return fileName.replace(/\.[^.]+$/, "");
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
