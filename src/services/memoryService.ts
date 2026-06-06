import {
  HydraConnectionTestResult,
  MemoryIngestionResult,
  MemoryRecallResult,
  TraceMemory
} from "../types/memory";
import { DiagnosticEvidence, Snapshot } from "../types/snapshot";
import {
  buildHydraMemoryPayload,
  getHydraConnection,
  parseHydraMemories
} from "./hydraClient";

export async function ingestMemory(
  snapshot: Snapshot,
  previousSnapshots: Snapshot[] = []
): Promise<MemoryIngestionResult> {
  const connection = getHydraConnection(snapshot.workspaceName);
  const memories = snapshotToMemories(
    snapshot,
    connection.userId,
    previousSnapshots
  );

  if (!connection.available || !connection.client) {
    const message =
      "HydraDB is not configured, so persistent cross-session memory is disabled.";
    console.log(`[TraceOS] ${message}`);
    return {
      attempted: memories.length,
      ingested: 0,
      hydraAvailable: false,
      message
    };
  }

  if (memories.length === 0) {
    return {
      attempted: 0,
      ingested: 0,
      hydraAvailable: true,
      message: "No diagnostic, git diff, terminal log, or repeated diagnostic evidence was available to ingest."
    };
  }

  try {
    await connection.client.context.ingest({
      type: "memory",
      tenantId: connection.tenantId,
      subTenantId: connection.subTenantId,
      upsert: true,
      memories: buildHydraMemoryPayload(memories)
    });

    const message = `Queued ${memories.length} real memory item${plural(memories.length)} for HydraDB ingestion.`;
    console.log(`[TraceOS] ${message}`);
    return {
      attempted: memories.length,
      ingested: memories.length,
      hydraAvailable: true,
      message
    };
  } catch (error) {
    const message = `HydraDB ingestion failed; snapshot remains saved locally: ${errorMessage(error)}`;
    console.error(`[TraceOS] ${message}`);
    return {
      attempted: memories.length,
      ingested: 0,
      hydraAvailable: true,
      message
    };
  }
}

export async function recallRelevantContext(
  request: string,
  snapshot: Snapshot
): Promise<MemoryRecallResult> {
  const connection = getHydraConnection(snapshot.workspaceName);
  if (!connection.available || !connection.client) {
    const message =
      "HydraDB is not configured, so persistent cross-session memory is disabled.";
    console.log(`[TraceOS] ${message}`);
    return {
      memories: [],
      hydraAvailable: false,
      message
    };
  }

  try {
    const response = await connection.client.query({
      tenantId: connection.tenantId,
      subTenantId: connection.subTenantId,
      query: buildEnrichedQuery(request, snapshot),
      type: "memory",
      queryBy: "hybrid",
      mode: "thinking",
      maxResults: 10,
      graphContext: true,
      recencyBias: 0.3
    });

    return {
      memories: parseHydraMemories(
        response,
        snapshot.workspaceName,
        connection.userId
      ),
      hydraAvailable: true
    };
  } catch (error) {
    const message = `HydraDB recall failed: ${errorMessage(error)}`;
    console.error(`[TraceOS] ${message}`);
    return {
      memories: [],
      hydraAvailable: false,
      message
    };
  }
}

export async function testHydraConnection(
  project: string
): Promise<HydraConnectionTestResult> {
  const connection = getHydraConnection(project);
  if (!connection.available || !connection.client) {
    return {
      success: false,
      message:
        "HydraDB API key is missing. Configure traceos.hydraApiKey or HYDRA_DB_API_KEY."
    };
  }

  try {
    await connection.client.query({
      tenantId: connection.tenantId,
      subTenantId: connection.subTenantId,
      query: "TraceOS connection verification",
      type: "memory",
      queryBy: "hybrid",
      mode: "fast",
      maxResults: 1,
      graphContext: false,
      recencyBias: 0
    });
    return {
      success: true,
      message: `HydraDB connection succeeded for ${connection.subTenantId}.`
    };
  } catch (error) {
    return {
      success: false,
      message: `HydraDB connection failed: ${errorMessage(error)}`
    };
  }
}

export function snapshotToMemories(
  snapshot: Snapshot,
  userId: string,
  previousSnapshots: Snapshot[] = []
): TraceMemory[] {
  const diagnosticMemories = snapshot.diagnostics.map((diagnostic, index) =>
    diagnosticMemory(snapshot, diagnostic, userId, index)
  );
  const memories: TraceMemory[] = [...diagnosticMemories];

  if (snapshot.git.diff) {
    memories.push({
      id: `${snapshot.id}:git_diff`,
      label: `Git diff at ${snapshot.timestamp}`,
      eventType: "git_diff",
      project: snapshot.workspaceName,
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
      project: snapshot.workspaceName,
      userId,
      rawEvidence: snapshot.terminalLog,
      summary: "Recent exact terminal log evidence.",
      tags: ["terminal"],
      importance: "medium",
      infer: false,
      timestamp: snapshot.timestamp
    });
  }

  memories.push(
    ...repeatedDiagnosticMemories(
      snapshot,
      diagnosticMemories,
      userId,
      previousSnapshots
    )
  );
  return memories;
}

function diagnosticMemory(
  snapshot: Snapshot,
  diagnostic: DiagnosticEvidence,
  userId: string,
  index: number
): TraceMemory {
  return {
    id: `${snapshot.id}:diagnostic:${index}`,
    label: `${diagnostic.severity} diagnostic in ${diagnostic.filePath}`,
    eventType: "diagnostic",
    project: snapshot.workspaceName,
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

function repeatedDiagnosticMemories(
  snapshot: Snapshot,
  diagnosticMemories: TraceMemory[],
  userId: string,
  previousSnapshots: Snapshot[]
): TraceMemory[] {
  const previousCounts = new Map<string, number>();
  for (const previous of previousSnapshots) {
    for (const diagnostic of previous.diagnostics) {
      const key = diagnosticKey(diagnostic);
      previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
    }
  }

  return snapshot.diagnostics.flatMap((diagnostic, index) => {
    const previousCount = previousCounts.get(diagnosticKey(diagnostic)) ?? 0;
    if (previousCount === 0) {
      return [];
    }

    const observedCount = previousCount + 1;
    return [
      {
        id: `${snapshot.id}:pattern:diagnostic:${index}`,
        label: `Repeated diagnostic in ${diagnostic.filePath}`,
        eventType: "pattern" as const,
        project: snapshot.workspaceName,
        userId,
        rawEvidence: JSON.stringify(
          {
            diagnostic,
            observedSnapshotCount: observedCount
          },
          null,
          2
        ),
        summary: `The exact diagnostic "${diagnostic.message}" was observed in ${observedCount} local snapshots.`,
        filePath: diagnostic.filePath,
        tags: ["pattern", "repeated-diagnostic"],
        importance:
          diagnostic.severity === "Error"
            ? ("high" as const)
            : ("medium" as const),
        relatedIds: [diagnosticMemories[index].id],
        infer: true,
        timestamp: snapshot.timestamp
      }
    ];
  });
}

function buildEnrichedQuery(request: string, snapshot: Snapshot): string {
  const evidence = [
    `User request: ${request}`,
    `Project: ${snapshot.workspaceName}`,
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

function diagnosticKey(diagnostic: DiagnosticEvidence): string {
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function plural(count: number): string {
  return count === 1 ? "" : "s";
}
