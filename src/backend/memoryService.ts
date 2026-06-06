import {
  MemoryRecallResult,
  TraceMemory
} from "../types/memory";
import { DiagnosticEvidence, Snapshot } from "../types/snapshot";
import { DiagnosticRegistry, RepeatedDiagnostic } from "./diagnosticRegistry";
import {
  buildHydraMemoryPayload,
  getHydraConnection,
  logHydraIngestRequest,
  parseHydraMemories
} from "./hydraClient";

export interface IngestionResult {
  received: {
    diagnostics: number;
    gitStatusLength: number;
    gitDiffLength: number;
    terminalLogLength: number;
  };
  attempted: number;
  ingested: number;
  skippedReasons: string[];
  message: string;
}

export async function ingestMemory(
  userId: string,
  project: string,
  snapshot: Snapshot,
  registry: DiagnosticRegistry
): Promise<IngestionResult> {
  const repeated = await registry.findRepeated(project, userId, snapshot);
  const memories = snapshotToMemories(snapshot, project, userId, repeated);
  const received = {
    diagnostics: snapshot.diagnostics.length,
    gitStatusLength: snapshot.git.status.length,
    gitDiffLength: snapshot.git.diff.length,
    terminalLogLength: snapshot.terminalLog.length
  };
  const skippedReasons = buildSkippedReasons(snapshot, repeated.length);

  await registry.record(project, userId, snapshot);
  console.log(
    `[TraceOS Backend] Built ${memories.length} memory item${plural(memories.length)} for ${project}/${userId}.`
  );

  if (memories.length === 0) {
    console.log(
      `[TraceOS Backend] HydraDB ingest skipped: ${skippedReasons.join("; ")}`
    );
    return {
      received,
      attempted: 0,
      ingested: 0,
      skippedReasons,
      message: skippedReasons.join("; ")
    };
  }

  try {
    const connection = getHydraConnection(project, userId);
    const hydraMemories = buildHydraMemoryPayload(memories);
    logHydraIngestRequest(connection, hydraMemories);
    await connection.client.context.ingest({
      type: "memory",
      tenantId: connection.tenantId,
      subTenantId: connection.subTenantId,
      upsert: true,
      memories: hydraMemories
    });
    console.log(
      `[TraceOS Backend] HydraDB ingest succeeded: ${memories.length}/${memories.length} memory item${plural(memories.length)} stored.`
    );
  } catch (error) {
    console.error(
      `[TraceOS Backend] HydraDB ingest failed for ${memories.length} memory item${plural(memories.length)}: ${errorMessage(error)}`
    );
    throw error;
  }

  return {
    received,
    attempted: memories.length,
    ingested: memories.length,
    skippedReasons,
    message: `Stored ${memories.length} real memory item${plural(memories.length)} in HydraDB.`
  };
}

export async function recallRelevantContext(
  userId: string,
  project: string,
  request: string,
  snapshot: Snapshot
): Promise<MemoryRecallResult> {
  const connection = getHydraConnection(project, userId);
  const response = await connection.client.query({
    tenantId: connection.tenantId,
    subTenantId: connection.subTenantId,
    query: buildEnrichedQuery(request, project, snapshot),
    type: "memory",
    queryBy: "hybrid",
    mode: "thinking",
    maxResults: 10,
    graphContext: true,
    recencyBias: 0.3
  });

  return {
    memories: parseHydraMemories(response, project, userId),
    hydraAvailable: true
  };
}

export function snapshotToMemories(
  snapshot: Snapshot,
  project: string,
  userId: string,
  repeatedDiagnostics: RepeatedDiagnostic[]
): TraceMemory[] {
  const diagnosticMemories = snapshot.diagnostics.map((diagnostic, index) =>
    diagnosticMemory(snapshot, project, diagnostic, userId, index)
  );
  const memories: TraceMemory[] = [...diagnosticMemories];

  if (snapshot.git.status) {
    memories.push({
      id: `${snapshot.id}:git_status`,
      label: `Git status at ${snapshot.timestamp}`,
      eventType: "git_status",
      project,
      userId,
      rawEvidence: snapshot.git.status,
      summary: `${snapshot.git.changedFiles.length} changed file${plural(snapshot.git.changedFiles.length)} reported by git status.`,
      tags: ["git", "status"],
      importance: "medium",
      infer: false,
      timestamp: snapshot.timestamp
    });
  }

  if (snapshot.git.diff) {
    memories.push({
      id: `${snapshot.id}:git_diff`,
      label: `Git diff at ${snapshot.timestamp}`,
      eventType: "git_diff",
      project,
      userId,
      rawEvidence: snapshot.git.diff,
      summary: snapshot.git.diffStat || "Exact git diff captured.",
      tags: ["git", "diff"],
      importance: "medium",
      infer: false,
      timestamp: snapshot.timestamp
    });
  }

  if (snapshot.terminalLog) {
    memories.push({
      id: `${snapshot.id}:terminal_log`,
      label: `Terminal log at ${snapshot.timestamp}`,
      eventType: "terminal_log",
      project,
      userId,
      rawEvidence: snapshot.terminalLog,
      summary: "Recent exact terminal log evidence.",
      tags: ["terminal"],
      importance: "medium",
      infer: false,
      timestamp: snapshot.timestamp
    });
  }

  for (const repeated of repeatedDiagnostics) {
    const diagnosticIndex = snapshot.diagnostics.indexOf(repeated.diagnostic);
    memories.push({
      id: `${snapshot.id}:pattern:diagnostic:${diagnosticIndex}`,
      label: `Repeated diagnostic in ${repeated.diagnostic.filePath}`,
      eventType: "pattern",
      project,
      userId,
      rawEvidence: JSON.stringify(repeated, null, 2),
      summary: `The exact diagnostic "${repeated.diagnostic.message}" was observed in ${repeated.observedSnapshotCount} distinct snapshots.`,
      filePath: repeated.diagnostic.filePath,
      tags: ["pattern", "repeated-diagnostic"],
      importance:
        repeated.diagnostic.severity === "Error" ? "high" : "medium",
      relatedIds: [`${snapshot.id}:diagnostic:${diagnosticIndex}`],
      infer: true,
      timestamp: snapshot.timestamp
    });
  }

  return memories;
}

function diagnosticMemory(
  snapshot: Snapshot,
  project: string,
  diagnostic: DiagnosticEvidence,
  userId: string,
  index: number
): TraceMemory {
  return {
    id: `${snapshot.id}:diagnostic:${index}`,
    label: `${diagnostic.severity} diagnostic in ${diagnostic.filePath}`,
    eventType: "diagnostic",
    project,
    userId,
    rawEvidence: JSON.stringify(diagnostic, null, 2),
    summary: diagnostic.message,
    filePath: diagnostic.filePath,
    tags: ["diagnostic", diagnostic.severity.toLowerCase()],
    importance: diagnostic.severity === "Error" ? "high" : "medium",
    infer: false,
    timestamp: snapshot.timestamp
  };
}

function buildEnrichedQuery(
  request: string,
  project: string,
  snapshot: Snapshot
): string {
  const evidence = [
    `User request: ${request}`,
    `Project: ${project}`,
    snapshot.activeFile ? `Current file: ${snapshot.activeFile}` : undefined,
    snapshot.diagnostics.length > 0
      ? `Diagnostic messages: ${snapshot.diagnostics
          .map((diagnostic) => diagnostic.message)
          .join(" | ")}`
      : undefined,
    snapshot.git.changedFiles.length > 0
      ? `Changed files: ${snapshot.git.changedFiles.join(", ")}`
      : undefined
  ];
  return evidence.filter((item): item is string => Boolean(item)).join("\n");
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}

function buildSkippedReasons(
  snapshot: Snapshot,
  repeatedDiagnosticCount: number
): string[] {
  const reasons: string[] = [];
  if (snapshot.diagnostics.length === 0) {
    reasons.push("No diagnostics found");
  }
  if (!snapshot.git.status) {
    reasons.push("Git status empty");
  }
  if (!snapshot.git.diff) {
    reasons.push("Git diff empty");
  }
  if (!snapshot.terminalLog) {
    reasons.push("Terminal log empty");
  }
  if (repeatedDiagnosticCount === 0) {
    reasons.push("No repeated diagnostics found");
  }
  if (
    snapshot.diagnostics.length === 0 &&
    !snapshot.git.status &&
    !snapshot.git.diff &&
    !snapshot.terminalLog
  ) {
    reasons.push("No meaningful evidence to ingest");
  }
  return reasons;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
