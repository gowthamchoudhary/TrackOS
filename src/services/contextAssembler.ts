import {
  MemoryRecallResult,
  TraceMemory
} from "../types/memory";
import {
  DiagnosticEvidence,
  Snapshot
} from "../types/snapshot";

const MAX_DIFF_CHARACTERS = 20_000;

export function assembleContext(
  request: string,
  current: Snapshot,
  previousSnapshots: Snapshot[],
  recall: MemoryRecallResult
): string {
  const sections = [
    "# TRACEOS CONTEXT",
    section("User Request", request),
    section(
      "Current Workspace",
      [
        `* Workspace: ${current.workspaceName} (${current.workspacePath})`,
        `* Active file: ${current.activeFile ?? "No active workspace file."}`,
        `* Timestamp: ${current.timestamp}`
      ].join("\n")
    ),
    section("Current Exact Diagnostics", formatDiagnostics(current.diagnostics)),
    section("Current Git Status", formatGitStatus(current)),
    section("Current Git Diff Summary", formatGitDiff(current)),
    section("Recent Terminal Log Evidence", formatTerminalLog(current.terminalLog)),
    section(
      "Repeated Diagnostics From Session",
      formatRepeatedDiagnostics(current.diagnostics, previousSnapshots)
    ),
    section("Previous HydraDB Memories", formatMemories(recall)),
    section(
      "Agent Instructions",
      [
        "* Use only the evidence above.",
        "* Do not assume errors that are not shown.",
        "* Avoid repeating diagnostics listed as repeated.",
        "* Prefer editing files shown in active file/git status when relevant.",
        "* Ask for missing evidence if required."
      ].join("\n")
    )
  ];

  return `${sections.join("\n\n")}\n`;
}

function section(title: string, content: string): string {
  return `## ${title}\n\n${content}`;
}

function formatDiagnostics(diagnostics: DiagnosticEvidence[]): string {
  if (diagnostics.length === 0) {
    return "No VS Code diagnostics currently reported.";
  }

  return diagnostics
    .map((diagnostic) => {
      const source = diagnostic.source ? ` source=${diagnostic.source}` : "";
      const code = diagnostic.code ? ` code=${diagnostic.code}` : "";
      return `* ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.character} [${diagnostic.severity}] ${diagnostic.message}${source}${code}`;
    })
    .join("\n");
}

function formatGitStatus(snapshot: Snapshot): string {
  if (snapshot.git.error) {
    return `Git evidence unavailable: ${snapshot.git.error}`;
  }

  if (!snapshot.git.status) {
    return "No git changes detected.";
  }

  return fenced("text", snapshot.git.status);
}

function formatGitDiff(snapshot: Snapshot): string {
  if (snapshot.git.error) {
    return `Git evidence unavailable: ${snapshot.git.error}`;
  }

  if (!snapshot.git.diffStat && !snapshot.git.diff) {
    return "No git diff detected.";
  }

  const parts: string[] = [];
  if (snapshot.git.diffStat) {
    parts.push("### Diff Stat", fenced("text", snapshot.git.diffStat));
  }

  if (snapshot.git.diff) {
    parts.push("### Exact Diff");
    if (snapshot.git.diff.length <= MAX_DIFF_CHARACTERS) {
      parts.push(fenced("diff", snapshot.git.diff));
    } else {
      parts.push(
        `Full diff omitted because it is ${snapshot.git.diff.length} characters, above the ${MAX_DIFF_CHARACTERS} character context limit.`
      );
    }
  }

  return parts.join("\n\n");
}

function formatTerminalLog(terminalLog: string): string {
  if (!terminalLog) {
    return "No terminal log evidence found. To capture terminal output, pipe command output into .traceos/terminal.log.";
  }

  return fenced("text", terminalLog);
}

function formatRepeatedDiagnostics(
  currentDiagnostics: DiagnosticEvidence[],
  previousSnapshots: Snapshot[]
): string {
  const previousCounts = new Map<string, number>();

  for (const snapshot of previousSnapshots) {
    for (const diagnostic of snapshot.diagnostics) {
      const key = diagnosticKey(diagnostic);
      previousCounts.set(key, (previousCounts.get(key) ?? 0) + 1);
    }
  }

  const repeated = currentDiagnostics
    .map((diagnostic) => ({
      diagnostic,
      previousCount: previousCounts.get(diagnosticKey(diagnostic)) ?? 0
    }))
    .filter(({ previousCount }) => previousCount > 0);

  if (repeated.length === 0) {
    return "No diagnostics in the current snapshot were observed in previous local snapshots.";
  }

  return repeated
    .map(
      ({ diagnostic, previousCount }) =>
        `* ${diagnostic.filePath}:${diagnostic.line}:${diagnostic.character} [${diagnostic.severity}] ${diagnostic.message} (seen in ${previousCount} previous snapshot${previousCount === 1 ? "" : "s"})`
    )
    .join("\n");
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

function formatMemories(recall: MemoryRecallResult): string {
  if (!recall.hydraAvailable) {
    const notConfiguredMessage =
      "HydraDB is not configured, so persistent cross-session memory is disabled.";
    return recall.message === notConfiguredMessage
      ? notConfiguredMessage
      : `HydraDB is currently unavailable. Using current local evidence only.${recall.message ? ` ${recall.message}` : ""}`;
  }

  if (recall.memories.length === 0) {
    return "HydraDB is configured, but no relevant memories were retrieved.";
  }

  return recall.memories.map(formatMemory).join("\n\n");
}

function formatMemory(memory: TraceMemory): string {
  const details = [
    `### ${memory.label}`,
    "",
    `* Event type: ${memory.eventType}`,
    `* Timestamp: ${memory.timestamp || "Not provided by HydraDB."}`,
    memory.filePath ? `* File: ${memory.filePath}` : undefined,
    "",
    memory.rawEvidence
  ];

  return details.filter((item): item is string => item !== undefined).join("\n");
}

function fenced(language: string, content: string): string {
  const fence = content.includes("```") ? "````" : "```";
  return `${fence}${language}\n${content}\n${fence}`;
}
