import {
  AgentRunEvidence,
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

export interface AgentIngestionResult {
  attempted: number;
  ingested: number;
  message: string;
}

export async function ingestMemory(
  userId: string,
  project: string,
  snapshot: Snapshot,
  registry: DiagnosticRegistry,
  teamId?: string
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

  await ingestTraceMemories(project, userId, memories, teamId);

  return {
    received,
    attempted: memories.length,
    ingested: memories.length,
    skippedReasons,
    message: `Stored ${memories.length} real memory item${plural(memories.length)} in HydraDB.`
  };
}

export async function ingestAgentOutput(
  userId: string,
  project: string,
  evidence: AgentRunEvidence,
  teamId?: string
): Promise<AgentIngestionResult> {
  const memories = agentEvidenceToMemories(evidence, project, userId);
  if (memories.length === 0) {
    return {
      attempted: 0,
      ingested: 0,
      message: "Agent produced no output or command failure evidence."
    };
  }

  // FIX: deduplicate memories by ID before ingesting.
  // agentEvidenceToMemories can produce :output, :error, and :command_failure
  // for the same evidence.id. If the same session runs twice (e.g. agent
  // retried), we'd get bc1bc3ee:error stored multiple times. Deduplicating
  // here prevents that before it even reaches HydraDB.
  const deduped = deduplicateMemoriesById(memories);
  if (deduped.length < memories.length) {
    console.log(
      `[TraceOS Backend] Deduplicated ${memories.length - deduped.length} duplicate agent memory item${plural(memories.length - deduped.length)} before ingest.`
    );
  }

  await ingestTraceMemories(project, userId, deduped, teamId);
  return {
    attempted: deduped.length,
    ingested: deduped.length,
    message: `Stored ${deduped.length} real agent memory item${plural(deduped.length)} in HydraDB.`
  };
}

export async function recallRelevantContext(
  userId: string,
  project: string,
  request: string,
  snapshot: Snapshot,
  teamId?: string
): Promise<MemoryRecallResult> {
  const connection = getHydraConnection(project, userId, teamId);
  const response = await connection.client.query({
    tenantId: connection.tenantId,
    subTenantId: connection.subTenantId,
    query: buildEnrichedQuery(request, project, snapshot),
    type: "memory",
    queryBy: "hybrid",
    mode: "thinking",
    maxResults: 20,
    graphContext: true,
    recencyBias: 0.3
  });

  const raw = parseHydraMemories(response, project, userId);
  const filtered = filterRelevantMemories(raw, request);
  return {
    memories: filtered,
    hydraAvailable: true
  };
}

function filterRelevantMemories(
  memories: TraceMemory[],
  request: string
): TraceMemory[] {
  // Extract meaningful keywords from request (words longer than 4 chars)
  const keywords = [
    ...new Set(
      request
        .toLowerCase()
        .split(/\W+/)
        .filter((word) => word.length > 4)
    )
  ];

  // Deduplicate by summary - keep most recent of each unique error
  const seenSummaries = new Map<string, TraceMemory>();
  for (const memory of memories) {
    const key = memory.summary?.slice(0, 80).toLowerCase() ?? memory.id;
    if (!seenSummaries.has(key)) {
      seenSummaries.set(key, memory);
    }
  }
  const deduped = [...seenSummaries.values()];

  // Keep only memories relevant to the request
  if (keywords.length === 0) {
    return deduped;
  }

  return deduped.filter((memory) => {
    const searchText = [
      memory.rawEvidence ?? "",
      memory.label ?? "",
      memory.summary ?? "",
      memory.filePath ?? ""
    ].join(" ").toLowerCase();

    return keywords.some((keyword) => searchText.includes(keyword));
  });
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

  // FIX: deduplicate snapshot memories by ID too (defensive)
  return deduplicateMemoriesById(memories);
}

function extractLesson(
  output: string,
  command: string,
  exitCode: number | null,
  errorPatterns: string[]
): string {
  const lines = output.split(/\r?\n/).filter((line) => line.trim());

  // Extract error lines
  const errorLines = lines
    .filter((line) => /error|failed|exception|cannot|undefined|null|timeout/i.test(line))
    .slice(0, 5)
    .map((line) => line.trim().slice(0, 200));

  // Extract file paths mentioned
  const filePaths = [
    ...new Set(output.match(/src\/[a-zA-Z0-9\/._-]+\.ts/g) ?? [])
  ].slice(0, 5);

  // Extract what was attempted
  const attemptLines = lines
    .filter((line) => /trying|attempting|running|applying|updating|fixing/i.test(line))
    .slice(0, 3)
    .map((line) => line.trim().slice(0, 150));

  const succeeded = exitCode === 0;

  return [
    `type: ${succeeded ? "successful_fix" : "failed_attempt"}`,
    ``,
    `task:`,
    `  ${command.slice(0, 150)}`,
    ``,
    `outcome:`,
    `  ${succeeded ? "Succeeded" : "Failed"}`,
    ``,
    errorPatterns.length > 0 ? `errors_detected:\n  ${errorPatterns.join("\n  ")}` : "",
    ``,
    errorLines.length > 0 ? `error_details:\n  ${errorLines.join("\n  ")}` : "",
    ``,
    filePaths.length > 0 ? `files_involved:\n  ${filePaths.join("\n  ")}` : "",
    ``,
    attemptLines.length > 0 ? `what_was_attempted:\n  ${attemptLines.join("\n  ")}` : "",
    ``,
    `avoid:`,
    `  ${succeeded ? "N/A" : `Repeating: ${errorPatterns[0] ?? "same approach"}`}`,
    ``,
    `confidence:`,
    `  ${succeeded ? "0.95" : "0.80"}`
  ].filter((line) => line !== "").join("\n");
}

export function agentEvidenceToMemories(
  evidence: AgentRunEvidence,
  project: string,
  userId: string
): TraceMemory[] {
  const memories: TraceMemory[] = [];
  const timestamp = evidence.completedAt;
  const common = {
    project,
    userId,
    infer: false,
    timestamp
  } as const;

  if (evidence.output) {
    memories.push({
      ...common,
      id: `${evidence.id}:output`,
      // FIX: summary is the actual command run, not a useless raw ID
      label: `${evidence.agentId} agent output`,
      eventType: "agent_output",
      rawEvidence: evidence.output,
      summary: `Captured stdout/stderr from: ${evidence.command}`,
      tags: ["agent", evidence.agentId, "output"],
      importance: "medium"
    });
  }

  if (evidence.errorPatterns.length > 0) {
    memories.push({
      ...common,
      id: `${evidence.id}:error`,
      label: `${evidence.agentId} agent error output`,
      eventType: "agent_error",
      rawEvidence: extractLesson(
        evidence.output || evidence.stderr,
        evidence.command,
        evidence.exitCode,
        evidence.errorPatterns
      ),
      summary: "Lesson extracted from agent session",
      tags: ["agent", evidence.agentId, "error", ...evidence.errorPatterns],
      importance: "high"
    });
  }

  if (evidence.exitCode !== 0) {
    memories.push({
      ...common,
      id: `${evidence.id}:command_failure`,
      label: `${evidence.agentId} agent command failure`,
      eventType: "agent_command_failure",
      rawEvidence: extractLesson(
        evidence.output || evidence.stderr,
        evidence.command,
        evidence.exitCode,
        evidence.errorPatterns
      ),
      summary: "Lesson extracted from failed command",
      tags: ["agent", evidence.agentId, "command-failure"],
      importance: "high"
    });
  }

  return memories;
}

/**
 * FIX: Deduplicate a list of memories by their ID.
 * Keeps the first occurrence of each ID (which is the most specific/recent).
 * This prevents the same bc1bc3ee:error from being written to HydraDB
 * multiple times across repeated agent runs.
 */
function deduplicateMemoriesById(memories: TraceMemory[]): TraceMemory[] {
  const seen = new Set<string>();
  return memories.filter((memory) => {
    if (seen.has(memory.id)) {
      return false;
    }
    seen.add(memory.id);
    return true;
  });
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
  // Extract semantic keywords from the request
  const keywords = request
    .toLowerCase()
    .split(/\W+/)
    .filter((word) => word.length > 3)
    .join(" ");

  const evidence = [
    `User request: ${request}`,
    `Semantic keywords: ${keywords}`,
    `Project: ${project}`,
    snapshot.activeFile ? `Current file: ${snapshot.activeFile}` : undefined,
    snapshot.diagnostics.length > 0
      ? `Current errors: ${snapshot.diagnostics.map((diagnostic) => diagnostic.message).join(" | ")}`
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

async function ingestTraceMemories(
  project: string,
  userId: string,
  memories: TraceMemory[],
  teamId?: string
): Promise<void> {
  try {
    const connection = getHydraConnection(project, userId, teamId);
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
}
