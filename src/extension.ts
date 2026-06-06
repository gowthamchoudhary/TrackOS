import { promises as fs } from "node:fs";
import * as vscode from "vscode";
import { AgentId, launchAgent } from "./services/agentRouter";
import { CaptureService } from "./services/captureService";
import { assembleContext } from "./services/contextAssembler";
import {
  ingestMemory,
  recallRelevantContext,
  testHydraConnection
} from "./services/memoryService";
import { SessionStore } from "./services/sessionStore";
import { WorkspaceInfo, getCurrentWorkspace } from "./utils/workspace";
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
    vscode.commands.registerCommand("traceos.askWithContext", () =>
      runCommand(askWithContext)
    ),
    vscode.commands.registerCommand("traceos.testHydraConnection", () =>
      runCommand(testHydraDbConnection)
    ),
    vscode.commands.registerCommand("traceos.ingestSnapshotToHydra", () =>
      runCommand(ingestSnapshotToHydra)
    ),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration("traceos.autoStartCapture")) {
        void runCommand(handleAutoStartConfigurationChange);
      }
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
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
  await showPrivacyNoticeOnce();
  await autoStartCapture();
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
  const workspace = requireWorkspace();
  if (!workspace) {
    return;
  }

  await extensionContext.globalState.update(CAPTURE_PAUSED_KEY, false);
  const service = getCaptureService(workspace);
  const wasStarted = service.isStarted;
  await service.start();
  updateCaptureStatus();
  if (!wasStarted) {
    vscode.window.setStatusBarMessage("TraceOS capture started", 5000);
    void vscode.window.showInformationMessage("TraceOS capture started");
  }
}

async function pauseCapture(): Promise<void> {
  await extensionContext.globalState.update(CAPTURE_PAUSED_KEY, true);
  for (const service of captureServices.values()) {
    service.pause();
  }
  updateCaptureStatus();
  void vscode.window.showInformationMessage("TraceOS capture paused");
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

async function askWithContext(): Promise<void> {
  const workspace = requireWorkspace();
  if (!workspace) {
    return;
  }

  const request = await vscode.window.showInputBox({
    title: "TraceOS: Ask With Context",
    prompt: "What should the coding agent help with?",
    ignoreFocusOut: true
  });

  if (request === undefined) {
    return;
  }

  if (!request.trim()) {
    void vscode.window.showWarningMessage(
      "TraceOS needs a request to build agent context."
    );
    return;
  }

  await generateContext(request.trim(), workspace);

  const document = await vscode.workspace.openTextDocument(
    vscode.Uri.file(workspace.contextFile)
  );
  await vscode.window.showTextDocument(document);

  const prompt =
    "Use .traceos/TRACEOS_CONTEXT.md as exact project context before answering. " +
    `User request: ${request.trim()}`;
  await vscode.env.clipboard.writeText(prompt);
  void vscode.window.showInformationMessage(
    "TraceOS context generated and agent prompt copied to clipboard."
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

  await generateContext(request, workspace);
  const launch = await launchAgent(agentId, request, workspace);
  const promptStatus = launch.autoSubmitted
    ? "The final prompt was submitted."
    : "The final prompt is inserted but not submitted.";
  return `Sent "${launch.command}" to a new TraceOS Agent terminal. ${promptStatus}`;
}

async function generateContext(
  request: string,
  workspace: WorkspaceInfo
): Promise<void> {
  const store = new SessionStore(workspace);
  const previousSession = await store.read();
  const snapshot = await getCaptureService(workspace).captureSnapshot();

  await store.append(snapshot);
  await ingestMemory(snapshot, previousSession.snapshots);
  const recall = await recallRelevantContext(request, snapshot);
  const markdown = assembleContext(
    request,
    snapshot,
    previousSession.snapshots,
    recall
  );
  await fs.writeFile(workspace.contextFile, markdown, "utf8");
}

async function testHydraDbConnection(): Promise<void> {
  const workspace = requireWorkspace();
  if (!workspace) {
    return;
  }

  const result = await testHydraConnection(workspace.name);
  if (result.success) {
    void vscode.window.showInformationMessage(result.message);
  } else {
    void vscode.window.showErrorMessage(result.message);
  }
}

async function ingestSnapshotToHydra(): Promise<void> {
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

  const previousSnapshots = session.snapshots.slice(0, -1);
  const result = await ingestMemory(snapshot, previousSnapshots);
  if (!result.hydraAvailable || result.ingested === 0) {
    void vscode.window.showWarningMessage(result.message);
    return;
  }

  void vscode.window.showInformationMessage(
    `TraceOS sent ${result.ingested} memory item${plural(result.ingested)} from the latest snapshot to HydraDB.`
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
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    updateCaptureStatus();
    return;
  }

  const configuration = vscode.workspace.getConfiguration(
    "traceos",
    workspace.folder.uri
  );
  const autoStart = configuration.get<boolean>("autoStartCapture", true);
  const paused = extensionContext.globalState.get<boolean>(
    CAPTURE_PAUSED_KEY,
    false
  );

  if (!autoStart || paused) {
    updateCaptureStatus();
    return;
  }

  const service = getCaptureService(workspace);
  if (!service.isStarted) {
    await service.start();
  }
  updateCaptureStatus();
}

async function handleAutoStartConfigurationChange(): Promise<void> {
  const workspace = getCurrentWorkspace();
  if (!workspace) {
    updateCaptureStatus();
    return;
  }

  const autoStart = vscode.workspace
    .getConfiguration("traceos", workspace.folder.uri)
    .get<boolean>("autoStartCapture", true);

  if (autoStart) {
    await autoStartCapture();
    return;
  }

  captureServices.get(workspace.rootPath)?.pause();
  updateCaptureStatus();
}

async function showPrivacyNoticeOnce(): Promise<void> {
  if (extensionContext.globalState.get<boolean>(PRIVACY_NOTICE_KEY, false)) {
    return;
  }

  await extensionContext.globalState.update(PRIVACY_NOTICE_KEY, true);
  const selection = await vscode.window.showInformationMessage(
    "TraceOS captures diagnostics, git diffs, and .traceos/terminal.log to build agent memory. You can pause capture anytime.",
    "Continue",
    "Open Settings",
    "Pause Capture"
  );

  if (selection === "Open Settings") {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "traceos"
    );
  } else if (selection === "Pause Capture") {
    await extensionContext.globalState.update(CAPTURE_PAUSED_KEY, true);
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
    ? "$(record) TraceOS: Capturing"
    : "$(debug-pause) TraceOS: Paused";
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
