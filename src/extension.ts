import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import {
  AgentId,
  buildAgentPrompt,
  launchAgent,
  resolveAgentCommand
} from "./services/agentRouter";
import { CaptureService } from "./services/captureService";
import {
  assembleManagedContext,
  ingestMemory,
  testBackend
} from "./services/memoryService";
import { SessionStore } from "./services/sessionStore";
import {
  WorkspaceInfo,
  getCurrentWorkspace,
  getFileSystemWorkspaces
} from "./utils/workspace";
import { TraceosViewProvider } from "./views/traceosViewProvider";

const captureServices = new Map<string, CaptureService>();
const PRIVACY_NOTICE_KEY = "traceos.privacyNoticeShown";
const CAPTURE_PAUSED_KEY = "traceos.capturePaused";
let extensionContext: vscode.ExtensionContext;
let captureStatusItem: vscode.StatusBarItem;

export async function activate(
  context: vscode.ExtensionContext
): Promise<void> {
  extensionContext = context;
  captureStatusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100
  );
  captureStatusItem.command = "traceos.captureStatusAction";
  captureStatusItem.show();

  const sidebarProvider = new TraceosViewProvider(
    context.extensionUri,
    runWithTraceosMemory
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(
      TraceosViewProvider.viewType,
      sidebarProvider
    ),
    vscode.commands.registerCommand("traceos.startCapture", () =>
      runCommand(startCapture)
    ),
    vscode.commands.registerCommand("traceos.pauseCapture", () =>
      runCommand(pauseCapture)
    ),
    vscode.commands.registerCommand("traceos.resumeCapture", () =>
      runCommand(resumeCapture)
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
  await showPrivacyNoticeOnce();
}

export function deactivate(): void {
  for (const service of captureServices.values()) {
    service.dispose();
  }
  captureServices.clear();
}

async function startCapture(): Promise<void> {
  await resumeCapture();
}

async function resumeCapture(): Promise<void> {
  if (getFileSystemWorkspaces().length === 0) {
    requireWorkspace();
    return;
  }

  await extensionContext.globalState.update(CAPTURE_PAUSED_KEY, false);
  await autoStartCapture();
}

async function pauseCapture(): Promise<void> {
  await extensionContext.globalState.update(CAPTURE_PAUSED_KEY, true);
  for (const service of captureServices.values()) {
    service.pause();
  }
  updateCaptureStatus();
}

async function captureStatusAction(): Promise<void> {
  const workspace = getCurrentWorkspace();
  const service = workspace
    ? captureServices.get(workspace.rootPath)
    : undefined;

  if (service?.isStarted) {
    await vscode.commands.executeCommand("workbench.view.extension.traceos");
    return;
  }

  await resumeCapture();
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
  agentId: AgentId
): Promise<string> {
  const workspace = requireWorkspace();
  if (!workspace) {
    throw new Error("TraceOS requires an open file-system workspace folder.");
  }

  const configuration = vscode.workspace.getConfiguration(
    "traceos",
    workspace.folder.uri
  );
  resolveAgentCommand(agentId, configuration);
  await generateContext(request, workspace);
  const launch = await launchAgent(agentId, request, workspace);
  if (!launch.launched) {
    await handleMissingAgent(launch.command, request, workspace);
    return "Agent CLI not found. Context generated and prompt copied.";
  }

  return launch.autoSubmitted
    ? `Started "${launch.command}" and submitted the TraceOS prompt.`
    : `Started "${launch.command}" and inserted the TraceOS prompt.`;
}

async function handleMissingAgent(
  command: string,
  request: string,
  workspace: WorkspaceInfo
): Promise<void> {
  const missingMessage =
    `Selected agent command '${command}' was not found. ` +
    "Install it or choose Custom with a valid command.";
  void vscode.window.showErrorMessage(missingMessage);

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(workspace.contextFile)
  );
  await vscode.window.showTextDocument(document);
  await vscode.env.clipboard.writeText(buildAgentPrompt(request));
  void vscode.window.showInformationMessage(
    "Agent CLI not found. Context generated and prompt copied."
  );
}

async function generateContext(
  request: string,
  workspace: WorkspaceInfo
): Promise<void> {
  const { snapshot, ingestion } = await getCaptureService(
    workspace
  ).captureAndSave({ forceIngestion: true });
  if (!ingestion.backendAvailable) {
    throw new Error(
      "Managed TraceOS backend ingestion failed. The agent was not started."
    );
  }

  const markdown = await assembleManagedContext(request, snapshot, workspace);
  if (!markdown) {
    throw new Error(
      "Managed TraceOS memory recall failed. The agent was not started."
    );
  }

  await fs.writeFile(workspace.contextFile, markdown, "utf8");
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

  const service = new CaptureService(workspace, new SessionStore(workspace));
  captureServices.set(workspace.rootPath, service);
  return service;
}

async function autoStartCapture(): Promise<void> {
  const workspaces = getFileSystemWorkspaces();
  if (workspaces.length === 0) {
    updateCaptureStatus();
    return;
  }
  const paused = extensionContext.globalState.get<boolean>(
    CAPTURE_PAUSED_KEY,
    false
  );

  if (paused) {
    updateCaptureStatus();
    return;
  }

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

async function showPrivacyNoticeOnce(): Promise<void> {
  if (extensionContext.globalState.get<boolean>(PRIVACY_NOTICE_KEY, false)) {
    return;
  }

  await extensionContext.globalState.update(PRIVACY_NOTICE_KEY, true);
  const selection = await vscode.window.showInformationMessage(
    "TraceOS runs automatically to capture diagnostics, git changes, and terminal log evidence for agent memory. You can pause it anytime.",
    "Pause Capture"
  );

  if (selection === "Pause Capture") {
    await extensionContext.globalState.update(CAPTURE_PAUSED_KEY, true);
    for (const service of captureServices.values()) {
      service.pause();
    }
    updateCaptureStatus();
  }
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
    : "TraceOS: Paused";
  captureStatusItem.tooltip = active
    ? "TraceOS capture is active. Click to open the TraceOS sidebar."
    : "TraceOS capture is paused. Click to resume.";
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
