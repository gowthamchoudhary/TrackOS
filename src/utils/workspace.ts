import * as path from "node:path";
import * as vscode from "vscode";

export interface WorkspaceInfo {
  folder: vscode.WorkspaceFolder;
  name: string;
  rootPath: string;
  traceDirectory: string;
  sessionFile: string;
  terminalLogFile: string;
  contextFile: string;
}

export function getCurrentWorkspace(): WorkspaceInfo | undefined {
  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const folder =
    (activeUri ? vscode.workspace.getWorkspaceFolder(activeUri) : undefined) ??
    vscode.workspace.workspaceFolders?.[0];

  if (!folder || folder.uri.scheme !== "file") {
    return undefined;
  }

  const rootPath = folder.uri.fsPath;
  const traceDirectory = path.join(rootPath, ".traceos");

  return {
    folder,
    name: folder.name,
    rootPath,
    traceDirectory,
    sessionFile: path.join(traceDirectory, "session.json"),
    terminalLogFile: path.join(traceDirectory, "terminal.log"),
    contextFile: path.join(traceDirectory, "TRACEOS_CONTEXT.md")
  };
}

export function relativeWorkspacePath(
  workspace: WorkspaceInfo,
  filePath: string
): string {
  const relativePath = path.relative(workspace.rootPath, filePath);
  return relativePath.split(path.sep).join("/");
}
