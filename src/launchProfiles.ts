import * as vscode from "vscode";
import { LaunchProfileRecord } from "./types";

type LaunchConfiguration = {
  name?: unknown;
  type?: unknown;
  request?: unknown;
  [key: string]: unknown;
};

type LaunchCompound = {
  name?: unknown;
  configurations?: unknown;
  [key: string]: unknown;
};

export function getLaunchProfiles(): LaunchProfileRecord[] {
  const folders = vscode.workspace.workspaceFolders;

  if (!folders || folders.length === 0) {
    return getProfilesForScope(undefined);
  }

  return folders.flatMap((folder) => getProfilesForScope(folder));
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
      detail: cloneJson(compound)
    }));

  return [...configProfiles, ...compoundProfiles];
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}

