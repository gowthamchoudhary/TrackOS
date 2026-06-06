import { createHash, randomUUID } from "node:crypto";
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
  private static readonly CAPTURE_DEBOUNCE_MS = 1_500;
  private static readonly DIAGNOSTIC_COOLDOWN_MS = 15_000;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pendingEvents: CaptureEvent[] = [];
  private captureTimer: NodeJS.Timeout | undefined;
  private captureQueue: Promise<void> = Promise.resolve();
  private lastDiagnosticIngestionAt = 0;
  private lastGitFingerprint = "";
  private lastTerminalFingerprint = "";
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
        if (files.length > 0) {
          this.recordEvent("diagnosticsChanged", files.join(", "));
          this.scheduleCapture();
        }
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
          this.scheduleCapture();
        }
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        const uri = editor?.document.uri;
        if (
          !uri ||
          uri.scheme !== "file" ||
          vscode.workspace.getWorkspaceFolder(uri)?.uri.fsPath !==
            this.workspace.rootPath
        ) {
          return;
        }
        this.recordEvent(
          "activeEditorChanged",
          relativeWorkspacePath(this.workspace, uri.fsPath)
        );
        this.scheduleCapture();
      })
    );

    const workspaceWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(this.workspace.folder, "**/*")
    );
    const onWorkspaceChange = (uri: vscode.Uri): void => {
      const relativePath = relativeWorkspacePath(this.workspace, uri.fsPath);
      if (relativePath === ".traceos/terminal.log") {
        return;
      }
      if (relativePath.startsWith(".traceos/")) {
        return;
      }
      this.recordEvent("workspaceChanged", relativePath);
      this.scheduleCapture();
    };
    workspaceWatcher.onDidChange(onWorkspaceChange, undefined, this.disposables);
    workspaceWatcher.onDidCreate(onWorkspaceChange, undefined, this.disposables);
    workspaceWatcher.onDidDelete(onWorkspaceChange, undefined, this.disposables);

    const terminalWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(
        this.workspace.folder,
        ".traceos/terminal.log"
      )
    );
    terminalWatcher.onDidChange(
      () => {
        this.recordEvent("terminalLogChanged", ".traceos/terminal.log");
        this.scheduleCapture();
      },
      undefined,
      this.disposables
    );
    terminalWatcher.onDidCreate(
      () => {
        this.recordEvent("terminalLogChanged", ".traceos/terminal.log");
        this.scheduleCapture();
      },
      undefined,
      this.disposables
    );
    this.disposables.push(workspaceWatcher, terminalWatcher);
    this.started = true;
    await this.captureAndSave({ forceIngestion: true });
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

  public async captureAndSave(
    options: { forceIngestion?: boolean } = {}
  ): Promise<{
    snapshot: Snapshot;
    ingestion: MemoryIngestionResult;
  }> {
    const snapshot = await this.captureSnapshot();
    await this.sessionStore.append(snapshot);
    const shouldIngest =
      options.forceIngestion === true || this.hasMeaningfulChange(snapshot);
    const ingestion = shouldIngest
      ? await ingestMemory(snapshot, this.workspace)
      : {
          attempted: 0,
          ingested: 0,
          backendAvailable: true,
          message: "No new diagnostic, git, or terminal evidence to ingest."
        };
    return { snapshot, ingestion };
  }

  public dispose(): void {
    this.disposeListeners();
  }

  private disposeListeners(): void {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
      this.captureTimer = undefined;
    }
    for (const disposable of this.disposables) {
      disposable.dispose();
    }
    this.disposables.length = 0;
    this.started = false;
  }

  private scheduleCapture(): void {
    if (this.captureTimer) {
      clearTimeout(this.captureTimer);
    }
    this.captureTimer = setTimeout(() => {
      this.captureTimer = undefined;
      this.captureQueue = this.captureQueue
        .then(async () => {
          if (this.started) {
            await this.captureAndSave();
          }
        })
        .catch((error: unknown) => {
          console.error(
            `[TraceOS] Automatic capture failed: ${
              error instanceof Error ? error.message : String(error)
            }`
          );
        });
    }, CaptureService.CAPTURE_DEBOUNCE_MS);
  }

  private hasMeaningfulChange(snapshot: Snapshot): boolean {
    const gitFingerprint = fingerprint([
      snapshot.git.status,
      snapshot.git.diffStat,
      snapshot.git.diff
    ]);
    const terminalFingerprint = fingerprint(snapshot.terminalLog);
    const hasDiagnosticEvent = snapshot.events.some(
      (event) => event.type === "diagnosticsChanged"
    );
    const now = Date.now();
    const diagnosticsDue =
      hasDiagnosticEvent &&
      now - this.lastDiagnosticIngestionAt >=
        CaptureService.DIAGNOSTIC_COOLDOWN_MS;
    const gitChanged =
      gitFingerprint !== this.lastGitFingerprint &&
      Boolean(snapshot.git.status || snapshot.git.diff);
    const terminalChanged =
      terminalFingerprint !== this.lastTerminalFingerprint &&
      Boolean(snapshot.terminalLog);

    this.lastGitFingerprint = gitFingerprint;
    this.lastTerminalFingerprint = terminalFingerprint;
    if (diagnosticsDue) {
      this.lastDiagnosticIngestionAt = now;
    }

    return diagnosticsDue || gitChanged || terminalChanged;
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

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
