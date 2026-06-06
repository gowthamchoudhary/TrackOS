import { randomUUID } from "node:crypto";
import * as vscode from "vscode";
import { collectDiagnostics } from "../collectors/diagnosticsCollector";
import { collectGitEvidence } from "../collectors/gitCollector";
import { collectTerminalLog } from "../collectors/terminalCollector";
import { CaptureEvent, Snapshot } from "../types/snapshot";
import { MemoryIngestionResult } from "../types/memory";
import {
  relativeWorkspacePath,
  WorkspaceInfo
} from "../utils/workspace";
import { ingestMemory } from "./memoryService";
import { SessionStore } from "./sessionStore";

export class CaptureService implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingEvents: CaptureEvent[] = [];
  private started = false;

  public constructor(
    private readonly workspace: WorkspaceInfo,
    private readonly sessionStore: SessionStore
  ) {}

  public async start(): Promise<void> {
    await this.sessionStore.initialize();
    if (this.started) {
      return;
    }

    this.disposables.push(
      vscode.languages.onDidChangeDiagnostics((event) => {
        const files = event.uris
          .filter(
            (uri) =>
              vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ===
              this.workspace.rootPath
          )
          .map((uri) => relativeWorkspacePath(this.workspace, uri.fsPath));
        this.recordEvent("diagnosticsChanged", files.join(", ") || undefined);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (
          vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath ===
          this.workspace.rootPath
        ) {
          this.recordEvent(
            "documentSaved",
            relativeWorkspacePath(this.workspace, document.uri.fsPath)
          );
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const uri = editor?.document.uri;
        const detail =
          uri &&
          uri.scheme === "file" &&
          vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath ===
            this.workspace.rootPath
            ? relativeWorkspacePath(this.workspace, uri.fsPath)
            : undefined;
        this.recordEvent("activeEditorChanged", detail);
      })
    );

    const terminalWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        this.workspace.folder,
        ".traceos/terminal.log"
      )
    );
    terminalWatcher.onDidChange(
      () => this.recordEvent("terminalLogChanged", ".traceos/terminal.log"),
      undefined,
      this.disposables
    );
    terminalWatcher.onDidCreate(
      () => this.recordEvent("terminalLogChanged", ".traceos/terminal.log"),
      undefined,
      this.disposables
    );
    this.disposables.push(terminalWatcher);
    this.started = true;
  }

  public get isStarted(): boolean {
    return this.started;
  }

  public pause(): void {
    this.disposeListeners();
  }

  public async captureSnapshot(): Promise<Snapshot> {
    await this.sessionStore.initialize();
    const activeFile = getActiveFile(this.workspace);
    const [git, terminalLog] = await Promise.all([
      collectGitEvidence(this.workspace.rootPath),
      collectTerminalLog(this.workspace.terminalLogFile)
    ]);

    const snapshot: Snapshot = {
      id: randomUUID(),
      timestamp: new Date().toISOString(),
      workspaceName: this.workspace.name,
      workspacePath: this.workspace.rootPath,
      activeFile,
      diagnostics: collectDiagnostics(this.workspace),
      git,
      terminalLog,
      events: this.pendingEvents.splice(0)
    };

    return snapshot;
  }

  public async captureAndSave(): Promise<{
    snapshot: Snapshot;
    ingestion: MemoryIngestionResult;
  }> {
    const previousSession = await this.sessionStore.read();
    const snapshot = await this.captureSnapshot();
    await this.sessionStore.append(snapshot);
    const ingestion = await ingestMemory(
      snapshot,
      previousSession.snapshots
    );
    return { snapshot, ingestion };
  }

  public dispose(): void {
    this.disposeListeners();
  }

  private disposeListeners(): void {
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.started = false;
  }

  private recordEvent(
    type: CaptureEvent["type"],
    detail?: string
  ): void {
    this.pendingEvents.push({
      type,
      timestamp: new Date().toISOString(),
      detail
    });
  }
}

function getActiveFile(workspace: WorkspaceInfo): string | undefined {
  const uri = vscode.window.activeTextEditor?.document.uri;
  if (
    !uri ||
    uri.scheme !== "file" ||
    vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath !== workspace.rootPath
  ) {
    return undefined;
  }

  return relativeWorkspacePath(workspace, uri.fsPath);
}
