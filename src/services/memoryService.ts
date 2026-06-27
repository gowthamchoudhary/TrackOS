import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  AgentEvidenceIngestionResult,
  AgentRunEvidence,
  BackendHealthResult,
  MemoryIngestionResult
} from "../types/memory";
import { Snapshot } from "../types/snapshot";
import { WorkspaceInfo } from "../utils/workspace";
import { SessionStore } from "./sessionStore";

const BACKEND_UNAVAILABLE =
  "TraceOS backend unavailable. Running local context only.";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BACKEND_URL = "https://trackos-h16r.onrender.com";
const DEDUPE_WINDOW_MS = 10 * 60 * 1000;
const ERROR_LIKE_PATTERN =
  /\b(error|exception|failed|failure|fatal|traceback|typeerror|syntaxerror|npm err!|command not found|module not found|exit code [1-9]\d*)\b/i;
const SUCCESS_LIKE_PATTERN =
  /\b(done|complete|completed|success|succeeded|fixed|passed|all tests passed)\b/i;
const recentFingerprints = new Map<string, number>();
const loadedFingerprintFiles = new Set<string>();
const startupFingerprintLoad = loadStartupFingerprints();
const previousAgentFailureByWorkspace = new Map<string, boolean>();

interface IngestResponse {
  ok: boolean;
  received: MemoryIngestionResult["received"];
  attempted: number;
  ingested: number;
  skippedReasons: string[];
  message: string;
}

interface AssembleResponse {
  ok: boolean;
  markdown: string;
}

interface HealthResponse {
  ok: boolean;
  hydraConfigured: boolean;
}

interface AgentEvidenceResponse {
  ok: boolean;
  attempted: number;
  ingested: number;
  message: string;
}

export async function ingestMemory(
  snapshot: Snapshot,
  workspace: WorkspaceInfo
): Promise<MemoryIngestionResult> {
  await loadRecentFingerprints(workspace);
  const filtering = await filterSnapshotForIngestion(snapshot, workspace);
  if (!filtering.shouldIngest) {
    return {
      received: evidenceCounts(snapshot),
      attempted: 0,
      ingested: 0,
      skippedReasons: filtering.reasons,
      backendAvailable: true,
      message: filtering.reasons.join("; ")
    };
  }

  try {
    const response = await postJson<IngestResponse>(
      workspace,
      "/api/memory/ingest",
      {
        userId: getUserId(workspace),
        teamId: getTeamId(workspace),
        project: workspace.name,
        workspaceName: filtering.snapshot.workspaceName,
        snapshot: filtering.snapshot
      }
    );
    await rememberFingerprints(filtering.fingerprints, workspace);

    return {
      received: response.received,
      attempted: response.attempted,
      ingested: response.ingested,
      skippedReasons: response.skippedReasons,
      backendAvailable: true,
      message: response.message
    };
  } catch (error) {
    console.error(`[TraceOS] Backend ingestion failed: ${errorMessage(error)}`);
    return {
      received: evidenceCounts(snapshot),
      attempted: 0,
      ingested: 0,
      skippedReasons: [errorMessage(error)],
      backendAvailable: false,
      message: `${BACKEND_UNAVAILABLE} ${errorMessage(error)}`
    };
  }
}

export async function assembleManagedContext(
  request: string,
  snapshot: Snapshot,
  workspace: WorkspaceInfo
): Promise<string | undefined> {
  try {
    const response = await postJson<AssembleResponse>(
      workspace,
      "/api/context/assemble",
      {
        userId: getUserId(workspace),
        teamId: getTeamId(workspace),
        project: workspace.name,
        request,
        snapshot
      }
    );
    return response.markdown;
  } catch (error) {
    console.error(`[TraceOS] Backend context failed: ${errorMessage(error)}`);
    return undefined;
  }
}

export async function ingestAgentEvidence(
  evidence: AgentRunEvidence,
  workspace: WorkspaceInfo
): Promise<AgentEvidenceIngestionResult> {
  await loadRecentFingerprints(workspace);
  const filtering = await filterAgentEvidenceForIngestion(evidence, workspace);
  if (!filtering.shouldIngest) {
    return {
      attempted: 0,
      ingested: 0,
      backendAvailable: true,
      message: filtering.reasons.join("; ")
    };
  }

  try {
    const response = await postJson<AgentEvidenceResponse>(
      workspace,
      "/api/memory/agent-output",
      {
        userId: getUserId(workspace),
        teamId: getTeamId(workspace),
        project: workspace.name,
        evidence: filtering.evidence
      }
    );
    await rememberFingerprints(filtering.fingerprints, workspace);
    previousAgentFailureByWorkspace.set(
      workspace.rootPath,
      evidence.exitCode !== 0
    );
    return {
      attempted: response.attempted,
      ingested: response.ingested,
      backendAvailable: true,
      message: response.message
    };
  } catch (error) {
    console.error(
      `[TraceOS] Agent evidence ingestion failed: ${errorMessage(error)}`
    );
    return {
      attempted: 0,
      ingested: 0,
      backendAvailable: false,
      message: `${BACKEND_UNAVAILABLE} ${errorMessage(error)}`
    };
  }
}

async function filterSnapshotForIngestion(
  snapshot: Snapshot,
  workspace: WorkspaceInfo
): Promise<{
  shouldIngest: boolean;
  snapshot: Snapshot;
  fingerprints: string[];
  reasons: string[];
}> {
  await pruneRecentFingerprints(workspace);
  const previous = await new SessionStore(workspace).read();
  const previousSnapshots = previous.snapshots.filter(
    (candidate) => candidate.id !== snapshot.id
  );
  const repeatedDiagnosticKeys = new Set<string>();
  for (const previousSnapshot of previousSnapshots) {
    for (const diagnostic of previousSnapshot.diagnostics) {
      repeatedDiagnosticKeys.add(diagnosticKey(diagnostic));
    }
  }

  const diagnosticEntries = snapshot.diagnostics
    .filter(
      (diagnostic) =>
        diagnostic.severity === "Error" ||
        repeatedDiagnosticKeys.has(diagnosticKey(diagnostic))
    )
    .map((diagnostic) => ({
      diagnostic,
      fingerprint: evidenceFingerprint(
        "diagnostic",
        diagnostic.filePath,
        `${diagnostic.severity}:${diagnostic.message}`
      )
    }))
    .filter(({ fingerprint }) => !wasRecentlyIngested(fingerprint));

  const gitHasMeaningfulDiff = isMeaningfulDiff(snapshot.git.diff);
  const gitHasImportantFile = snapshot.git.changedFiles.some(isImportantFile);
  const gitFingerprint = evidenceFingerprint(
    "git_diff",
    snapshot.git.changedFiles.join(","),
    snapshot.git.diff || snapshot.git.status
  );
  const includeGit =
    (gitHasMeaningfulDiff || gitHasImportantFile) &&
    !wasRecentlyIngested(gitFingerprint);

  const terminalHasSignal = ERROR_LIKE_PATTERN.test(snapshot.terminalLog);
  const terminalFingerprint = evidenceFingerprint(
    "terminal_log",
    ".traceos/terminal.log",
    signalSnippet(snapshot.terminalLog)
  );
  const includeTerminal =
    terminalHasSignal && !wasRecentlyIngested(terminalFingerprint);

  const filteredSnapshot: Snapshot = {
    ...snapshot,
    diagnostics: diagnosticEntries.map(({ diagnostic }) => diagnostic),
    git: includeGit
      ? snapshot.git
      : {
          ...snapshot.git,
          status: "",
          diffStat: "",
          diff: "",
          changedFiles: []
        },
    terminalLog: includeTerminal ? snapshot.terminalLog : ""
  };
  const fingerprints = [
    ...diagnosticEntries.map(({ fingerprint }) => fingerprint),
    includeGit ? gitFingerprint : undefined,
    includeTerminal ? terminalFingerprint : undefined
  ].filter((value): value is string => Boolean(value));
  const hasSignal =
    filteredSnapshot.diagnostics.length > 0 ||
    Boolean(filteredSnapshot.git.diff || filteredSnapshot.git.status) ||
    Boolean(filteredSnapshot.terminalLog);

  if (!hasSignal) {
    return {
      shouldIngest: false,
      snapshot: filteredSnapshot,
      fingerprints,
      reasons: ["No memory-worthy evidence after TraceOS filtering"]
    };
  }

  return {
    shouldIngest: true,
    snapshot: filteredSnapshot,
    fingerprints,
    reasons: []
  };
}

async function filterAgentEvidenceForIngestion(
  evidence: AgentRunEvidence,
  workspace: WorkspaceInfo
): Promise<{
  shouldIngest: boolean;
  evidence: AgentRunEvidence;
  fingerprints: string[];
  reasons: string[];
}> {
  await pruneRecentFingerprints(workspace);
  const hadPreviousFailure =
    previousAgentFailureByWorkspace.get(workspace.rootPath) === true;
  const outputHasError = ERROR_LIKE_PATTERN.test(evidence.output);
  const nonZeroExit = evidence.exitCode !== 0;
  const successAfterFailure =
    hadPreviousFailure && evidence.exitCode === 0 && SUCCESS_LIKE_PATTERN.test(evidence.output);
  const fingerprint = evidenceFingerprint(
    nonZeroExit ? "agent_command_failure" : "agent_output",
    evidence.command,
    signalSnippet(evidence.output || evidence.stderr)
  );

  previousAgentFailureByWorkspace.set(workspace.rootPath, nonZeroExit);
  if (
    !outputHasError &&
    !nonZeroExit &&
    !successAfterFailure
  ) {
    return {
      shouldIngest: false,
      evidence,
      fingerprints: [],
      reasons: ["Agent output had no useful memory signal"]
    };
  }
  if (wasRecentlyIngested(fingerprint)) {
    return {
      shouldIngest: false,
      evidence,
      fingerprints: [fingerprint],
      reasons: ["Duplicate agent output memory recently ingested"]
    };
  }

  return {
    shouldIngest: true,
    evidence,
    fingerprints: [fingerprint],
    reasons: []
  };
}

export async function testBackend(
  workspace: WorkspaceInfo
): Promise<BackendHealthResult> {
  try {
    const response = await requestJson<HealthResponse>(
      workspace,
      "/api/health",
      { method: "GET" }
    );
    return {
      success: response.ok,
      hydraConfigured: response.hydraConfigured,
      message: response.hydraConfigured
        ? "TraceOS backend is healthy and managed memory is configured."
        : "TraceOS backend is healthy, but managed memory is not configured."
    };
  } catch (error) {
    return {
      success: false,
      hydraConfigured: false,
      message: `${BACKEND_UNAVAILABLE} ${errorMessage(error)}`
    };
  }
}

export function backendUnavailableMessage(): string {
  return BACKEND_UNAVAILABLE;
}

async function postJson<T>(
  workspace: WorkspaceInfo,
  path: string,
  body: unknown
): Promise<T> {
  return requestJson<T>(workspace, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function requestJson<T>(
  workspace: WorkspaceInfo,
  path: string,
  init: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${getBackendUrl(workspace)}${path}`, {
      ...init,
      signal: controller.signal
    });
    const payload = (await response.json()) as T & { message?: string };
    if (!response.ok) {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function getBackendUrl(workspace: WorkspaceInfo): string {
  const configured = vscode.workspace
    .getConfiguration("traceos", workspace.folder.uri)
    .get<string>("backendUrl", DEFAULT_BACKEND_URL)
    .trim();
  return (configured || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

function getUserId(workspace: WorkspaceInfo): string {
  return (
    vscode.workspace
      .getConfiguration("traceos", workspace.folder.uri)
      .get<string>("userId", "local_user")
      .trim() || "local_user"
  );
}

function getTeamId(workspace: WorkspaceInfo): string {
  return vscode.workspace
    .getConfiguration("traceos", workspace.folder.uri)
    .get<string>("teamId", "")
    .trim();
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evidenceCounts(
  snapshot: Snapshot
): MemoryIngestionResult["received"] {
  return {
    diagnostics: snapshot.diagnostics.length,
    gitStatusLength: snapshot.git.status.length,
    gitDiffLength: snapshot.git.diff.length,
    terminalLogLength: snapshot.terminalLog.length
  };
}

function diagnosticKey(diagnostic: Snapshot["diagnostics"][number]): string {
  return JSON.stringify([
    diagnostic.filePath,
    diagnostic.line,
    diagnostic.character,
    diagnostic.severity,
    diagnostic.message,
    diagnostic.source ?? "",
    diagnostic.code ?? ""
  ]);
}

function isMeaningfulDiff(diff: string): boolean {
  if (!diff.trim()) {
    return false;
  }
  return /^(?:\+|-)(?![+-]{2,3}|$).+/m.test(diff);
}

function isImportantFile(filePath: string): boolean {
  return (
    filePath.startsWith("src/") ||
    filePath === "package.json" ||
    filePath === "tsconfig.json"
  );
}

function signalSnippet(value: string): string {
  const line =
    value
      .split(/\r?\n/)
      .find((candidate) => ERROR_LIKE_PATTERN.test(candidate)) ??
    value.slice(0, 500);
  return line.trim().slice(0, 500);
}

function evidenceFingerprint(
  eventType: string,
  filePath: string,
  evidence: string
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        eventType,
        filePath,
        createHash("sha256").update(evidence).digest("hex")
      ])
    )
    .digest("hex");
}

function wasRecentlyIngested(fingerprint: string): boolean {
  const ingestedAt = recentFingerprints.get(fingerprint);
  return (
    ingestedAt !== undefined &&
    Date.now() - ingestedAt < DEDUPE_WINDOW_MS
  );
}

async function loadStartupFingerprints(): Promise<void> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  await Promise.all(
    folders
      .filter((folder) => folder.uri.scheme === "file")
      .map((folder) =>
        loadFingerprintFile(
          path.join(folder.uri.fsPath, ".traceos", "fingerprints.json")
        )
      )
  );
}

async function loadRecentFingerprints(workspace: WorkspaceInfo): Promise<void> {
  await startupFingerprintLoad;
  await loadFingerprintFile(fingerprintFile(workspace));
}

async function loadFingerprintFile(filePath: string): Promise<void> {
  if (loadedFingerprintFiles.has(filePath)) {
    return;
  }
  loadedFingerprintFiles.add(filePath);

  let contents: string;
  try {
    contents = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      console.warn(
        `[TraceOS] Failed to read diagnostic fingerprints: ${errorMessage(error)}`
      );
    }
    return;
  }

  try {
    const persisted = JSON.parse(contents) as Record<string, unknown>;
    const now = Date.now();
    for (const [fingerprint, ingestedAt] of Object.entries(persisted)) {
      if (
        typeof ingestedAt === "number" &&
        Number.isFinite(ingestedAt) &&
        now - ingestedAt < DEDUPE_WINDOW_MS
      ) {
        recentFingerprints.set(fingerprint, ingestedAt);
      }
    }
  } catch (error) {
    console.warn(
      `[TraceOS] Failed to parse diagnostic fingerprints: ${errorMessage(error)}`
    );
  }
}

async function rememberFingerprints(
  fingerprints: string[],
  workspace: WorkspaceInfo
): Promise<void> {
  const now = Date.now();
  for (const fingerprint of fingerprints) {
    recentFingerprints.set(fingerprint, now);
  }
  await pruneRecentFingerprints(workspace);
}

async function pruneRecentFingerprints(workspace: WorkspaceInfo): Promise<void> {
  const now = Date.now();
  for (const [fingerprint, ingestedAt] of recentFingerprints) {
    if (now - ingestedAt >= DEDUPE_WINDOW_MS) {
      recentFingerprints.delete(fingerprint);
    }
  }
  await persistRecentFingerprints(workspace);
}

async function persistRecentFingerprints(
  workspace: WorkspaceInfo
): Promise<void> {
  const fingerprints = Object.fromEntries(
    [...recentFingerprints].filter(
      ([, ingestedAt]) => Date.now() - ingestedAt < DEDUPE_WINDOW_MS
    )
  );
  try {
    await fs.mkdir(workspace.traceDirectory, { recursive: true });
    await fs.writeFile(
      fingerprintFile(workspace),
      `${JSON.stringify(fingerprints, null, 2)}\n`,
      "utf8"
    );
  } catch (error) {
    console.warn(
      `[TraceOS] Failed to persist diagnostic fingerprints: ${errorMessage(error)}`
    );
  }
}

function fingerprintFile(workspace: WorkspaceInfo): string {
  return path.join(workspace.traceDirectory, "fingerprints.json");
}
