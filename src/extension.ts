import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import {
  AgentRunner,
  AgentId,
  buildAgentPrompt
} from "./services/agentRunner";
import { CaptureService } from "./services/captureService";
import {
  assembleManagedContext,
  ingestAgentEvidence,
  ingestMemory,
  testBackend
} from "./services/memoryService";
import { assembleContext } from "./services/contextAssembler";
import { SessionStore } from "./services/sessionStore";
import {
  WorkspaceInfo,
  getCurrentWorkspace,
  getFileSystemWorkspaces
} from "./utils/workspace";
import {
  TraceosRunStatus,
  TraceosViewProvider
} from "./views/traceosViewProvider";

const captureServices = new Map<string, CaptureService>();
let captureStatusItem: vscode.StatusBarItem;
let sidebarProvider: TraceosViewProvider;
let agentRunner: AgentRunner;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  captureStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  captureStatusItem.command = "traceos.captureStatusAction";
  captureStatusItem.show();
  const agentOutput = vscode.window.createOutputChannel("TraceOS Agent");
  agentRunner = new AgentRunner(agentOutput);

  sidebarProvider = new TraceosViewProvider(
    context.extensionUri,
    runWithTraceosMemory
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TraceosViewProvider.viewType,
      sidebarProvider
    ),
    vscode.commands.registerCommand("traceos.captureStatusAction", () =>
      runCommand(captureStatusAction)
    ),
    vscode.commands.registerCommand("traceos.snapshotState", () =>
      runCommand(snapshotState)
    ),
    vscode.commands.registerCommand("traceos.testBackendConnection", () =>
      runCommand(testBackendConnection)
    ),
    vscode.commands.registerCommand("traceos.ingestSnapshotToBackend", () =>
      runCommand(ingestSnapshotToBackend)
    ),
    vscode.workspace.onDidChangeWorkspaceFolders((event) => {
      for (const removed of event.removed) {
        const service = captureServices.get(removed.uri.fsPath);
        service?.dispose();
        captureServices.delete(removed.uri.fsPath);
      }
      void runCommand(autoStartCapture);
    }),
    captureStatusItem,
    agentRunner,
    agentOutput,
    {
      dispose: () => {
        for (const service of captureServices.values()) {
          service.dispose();
        }
        captureServices.clear();
      }
    }
  );

  updateCaptureStatus();
  await autoStartCapture();
}

export function deactivate(): void {
  for (const service of captureServices.values()) {
    service.dispose();
  }
  captureServices.clear();
}

async function captureStatusAction(): Promise<void> {
  if (!requireWorkspace()) {
    return;
  }
  await vscode.commands.executeCommand("workbench.view.extension.traceos");
}

async function snapshotState(): Promise<void> {
  const workspace = requireWorkspace();
  if (!workspace) {
    return;
  }

  const { snapshot, ingestion } =
    await getCaptureService(workspace).captureAndSave();
  const diagnosticCount = snapshot.diagnostics.length;
  const changedFileCount = snapshot.git.changedFiles.length;
  const gitNote = snapshot.git.error ? " Git evidence was unavailable." : "";

  void vscode.window.showInformationMessage(
    `TraceOS captured ${diagnosticCount} diagnostic${plural(diagnosticCount)} and ${changedFileCount} changed file${plural(changedFileCount)}.${gitNote} ${ingestion.message}`
  );
}

async function runWithTraceosMemory(
  request: string,
  agentId: AgentId,
  reportStatus: (
    status: TraceosRunStatus,
    state?: "running" | "success" | "error"
  ) => Promise<void>
): Promise<string> {
  const workspace = requireWorkspace();
  if (!workspace) {
    throw new Error("TraceOS requires an open file-system workspace folder.");
  }

  await generateContext(request, workspace, reportStatus);
  const prompt = buildAgentPrompt(request);
  await fs.writeFile(workspace.agentPromptFile, prompt, "utf8");
  await reportStatus("Context generated");

  await reportStatus("Starting TraceOS Agent");
  const run = await agentRunner.run(agentId, workspace);
  if (!run.launched) {
    await handleMissingAgent(run.command, prompt, workspace);
    await reportStatus("CLI missing, prompt copied");
    return "CLI missing, prompt copied";
  }

  await reportStatus("Agent completed; storing captured output");
  const ingestion = await ingestAgentEvidence(run.evidence, workspace);
  if (!ingestion.backendAvailable) {
    await reportStatus(`Backend error: ${ingestion.message}`, "error");
  } else {
    await reportStatus(
      `Agent memories stored: ${ingestion.ingested}`,
      "success"
    );
  }

  if (run.evidence.exitCode !== 0) {
    throw new Error(
      `Agent exited with code ${String(run.evidence.exitCode)}. Captured output is in TraceOS Agent and .traceos/agent-session.log.`
    );
  }

  return ingestion.backendAvailable
    ? `Agent completed; memories stored: ${ingestion.ingested}`
    : "Agent completed; backend ingestion failed";
}

async function handleMissingAgent(
  command: string,
  prompt: string,
  workspace: WorkspaceInfo
): Promise<void> {
  const missingMessage =
    `Selected agent CLI '${command}' was not found. ` +
    "TraceOS generated context and copied the prompt. " +
    "Install the CLI or choose Custom command.";

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(workspace.agentPromptFile)
  );
  await vscode.window.showTextDocument(document);
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showWarningMessage(missingMessage);
}

async function generateContext(
  request: string,
  workspace: WorkspaceInfo,
  reportStatus: (
    status: TraceosRunStatus,
    state?: "running" | "success" | "error"
  ) => Promise<void>
): Promise<void> {
  await reportStatus("Capturing");
  const { snapshot, ingestion } = await getCaptureService(
    workspace
  ).captureAndSave({
    forceIngestion: true,
    notify: false,
    onBeforeIngest: () => reportStatus("Ingesting memory")
  });
  if (ingestion.backendAvailable) {
    await reportStatus(
      `Memories stored: ${ingestion.ingested}`,
      "success"
    );
  } else {
    await reportStatus(`Backend error: ${ingestion.message}`, "error");
  }

  const managedMarkdown = await assembleManagedContext(
    request,
    snapshot,
    workspace
  );
  if (!managedMarkdown) {
    await reportStatus(
      "Backend error: context assembly failed; using local context",
      "error"
    );
  }
  const markdown =
    managedMarkdown ??
    assembleContext(
      request,
      snapshot,
      await getPreviousSnapshots(workspace, snapshot.id),
      {
        memories: [],
        hydraAvailable: false,
        message: ingestion.message
      }
    );

  await fs.writeFile(workspace.contextFile, markdown, "utf8");
}

async function getPreviousSnapshots(
  workspace: WorkspaceInfo,
  currentSnapshotId: string
): Promise<import("./types/snapshot").Snapshot[]> {
  const session = await new SessionStore(workspace).read();
  return session.snapshots.filter(
    (snapshot) => snapshot.id !== currentSnapshotId
  );
}

async function testBackendConnection(): Promise<void> {
  const workspace = requireWorkspace();
  if (!workspace) {
    return;
  }

  const result = await testBackend(workspace);
  if (result.success) {
    void vscode.window.showInformationMessage(result.message);
  } else {
    void vscode.window.showErrorMessage(result.message);
  }
}

async function ingestSnapshotToBackend(): Promise<void> {
  const workspace = requireWorkspace();
  if (!workspace) {
    return;
  }

  const store = new SessionStore(workspace);
  const session = await store.read();
  const snapshot = session.snapshots.at(-1);
  if (!snapshot) {
    void vscode.window.showWarningMessage(
      "TraceOS has no local snapshot to ingest. Run TraceOS: Snapshot State first."
    );
    return;
  }

  const result = await ingestMemory(snapshot, workspace);
  if (!result.backendAvailable || result.ingested === 0) {
    void vscode.window.showWarningMessage(result.message);
    return;
  }

  void vscode.window.showInformationMessage(
    `TraceOS sent ${result.ingested} memory item${plural(result.ingested)} from the latest snapshot to the managed backend.`
  );
}

function getCaptureService(workspace: WorkspaceInfo): CaptureService {
  const existing = captureServices.get(workspace.rootPath);
  if (existing) {
    return existing;
  }

  const service = new CaptureService(
    workspace,
    new SessionStore(workspace),
    async (ingestion) => {
      if (!sidebarProvider) {
        return;
      }
      if (!ingestion.backendAvailable) {
        await sidebarProvider.reportStatus(
          `Backend error: ${ingestion.message}`,
          "error"
        );
        return;
      }
      await sidebarProvider.reportStatus(
        `Memories stored: ${ingestion.ingested}`,
        "success"
      );
    }
  );
  captureServices.set(workspace.rootPath, service);
  return service;
}

async function autoStartCapture(): Promise<void> {
  const workspaces = getFileSystemWorkspaces();
  if (workspaces.length === 0) {
    updateCaptureStatus();
    return;
  }
  await sidebarProvider?.reportStatus("Capturing");
  await Promise.all(
    workspaces.map(async (workspace) => {
      const service = getCaptureService(workspace);
      if (!service.isStarted) {
        await service.start();
      }
    })
  );
  updateCaptureStatus();
}

function updateCaptureStatus(): void {
  if (!captureStatusItem) {
    return;
  }

  const workspace = getCurrentWorkspace();
  const active =
    workspace &&
    captureServices.get(workspace.rootPath)?.isStarted === true;

  captureStatusItem.text = active
    ? "TraceOS: Capturing"
    : "TraceOS: Starting";
  captureStatusItem.tooltip = active
    ? "TraceOS capture is active. Click to open the TraceOS sidebar."
    : "TraceOS is starting automatic capture.";
}

function requireWorkspace(): WorkspaceInfo | undefined {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    void vscode.window.showErrorMessage(
      "TraceOS requires an open file-system workspace folder."
    );
  }
  return workspace;
}

async function runCommand(command: () => Promise<void>): Promise<void> {
  try {
    await command();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    void vscode.window.showErrorMessage(`TraceOS: ${message}`);
  }
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
