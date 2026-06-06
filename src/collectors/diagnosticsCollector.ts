import * as vscode from "vscode";
import { DiagnosticEvidence } from "../types/snapshot";
import {
  relativeWorkspacePath,
  WorkspaceInfo
} from "../utils/workspace";

const severityNames: Record<vscode.DiagnosticSeverity, string> = {
  [vscode.DiagnosticSeverity.Error]: "Error",
  [vscode.DiagnosticSeverity.Warning]: "Warning",
  [vscode.DiagnosticSeverity.Information]: "Information",
  [vscode.DiagnosticSeverity.Hint]: "Hint"
};

export function collectDiagnostics(
  workspace: WorkspaceInfo
): DiagnosticEvidence[] {
  const evidence: DiagnosticEvidence[] = [];

  for (const [uri, diagnostics] of vscode.languages.getDiagnostics()) {
    if (uri.scheme !== "file") {
      continue;
    }

    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (folder?.uri.fsPath !== workspace.rootPath) {
      continue;
    }

    for (const diagnostic of diagnostics) {
      evidence.push({
        filePath: relativeWorkspacePath(workspace, uri.fsPath),
        line: diagnostic.range.start.line + 1,
        character: diagnostic.range.start.character + 1,
        severity: severityNames[diagnostic.severity],
        message: diagnostic.message,
        source: diagnostic.source,
        code: getDiagnosticCode(diagnostic.code)
      });
    }
  }

  return evidence;
}

function getDiagnosticCode(
  code: vscode.Diagnostic["code"]
): string | undefined {
  if (code === undefined) {
    return undefined;
  }

  if (typeof code === "object") {
    return String(code.value);
  }

  return String(code);
}
