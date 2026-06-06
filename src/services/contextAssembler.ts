import {
  MemoryRecallResult,
  TraceMemory,
  TraceMemoryEventType
} from "../types/memory";
import { DiagnosticEvidence, Snapshot } from "../types/snapshot";

const MAX_SNIPPET_CHARACTERS = 900;
const RELEVANT_MEMORY_TYPES = new Set<TraceMemoryEventType>([
  "failure",
  "fix",
  "diagnostic",
  "agent_error",
  "agent_command_failure",
  "terminal_log",
  "pattern"
]);
const ERROR_LIKE_PATTERN =
  /\b(error|exception|failed|failure|fatal|traceback|typeerror|syntaxerror|npm err!|command not found|module not found|exit code [1-9]\d*)\b/i;

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
    section("Previous TraceOS Memories", formatMemories(recall)),
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
  if (snapshot.git.changedFiles.length > 0) {
    parts.push(`Changed files: ${snapshot.git.changedFiles.join(", ")}`);
  }
  if (snapshot.git.diffStat) {
    parts.push("### Diff Stat", fenced("text", snapshot.git.diffStat));
  }
  if (snapshot.git.diff && hasErrorLikeDiffLine(snapshot.git.diff)) {
    parts.push(
      "### Relevant Diff Snippet",
      fenced("diff", firstMatchingLines(snapshot.git.diff, ERROR_LIKE_PATTERN))
    );
  } else if (snapshot.git.diff) {
    parts.push("Exact diff omitted by default; use git status and diff stat unless exact code is requested.");
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
    return (
      recall.message ??
      "TraceOS backend unavailable. Running local context only."
    );
  }

  if (recall.memories.length === 0) {
    return "No relevant managed memories were retrieved.";
  }

  const memories = recall.memories
    .filter(isRelevantMemory)
    .sort(memoryPriority)
    .slice(0, 8);

  if (memories.length === 0) {
    return "Retrieved managed memories did not match TraceOS relevance filters.";
  }

  return memories.map(formatMemory).join("\n\n");
}

function formatMemory(memory: TraceMemory): string {
  const evidence = summarizeMemoryEvidence(memory);
  const details = [
    `### ${memory.label}`,
    "",
    `* Event type: ${memory.eventType}`,
    `* Timestamp: ${memory.timestamp || "Not provided."}`,
    memory.filePath ? `* File: ${memory.filePath}` : undefined,
    memory.summary ? `* Summary: ${memory.summary}` : undefined,
    "",
    evidence
  ];

  return details.filter((item): item is string => item !== undefined).join("\n");
}

function isRelevantMemory(memory: TraceMemory): boolean {
  if (RELEVANT_MEMORY_TYPES.has(memory.eventType)) {
    return true;
  }
  if (memory.importance === "high") {
    return true;
  }
  return ERROR_LIKE_PATTERN.test(memory.summary) || ERROR_LIKE_PATTERN.test(memory.rawEvidence);
}

function memoryPriority(a: TraceMemory, b: TraceMemory): number {
  return scoreMemory(b) - scoreMemory(a);
}

function scoreMemory(memory: TraceMemory): number {
  let score = 0;
  if (memory.importance === "high") {
    score += 5;
  }
  if (memory.eventType === "agent_error" || memory.eventType === "agent_command_failure") {
    score += 4;
  }
  if (memory.eventType === "failure" || memory.eventType === "fix") {
    score += 3;
  }
  if (memory.eventType === "pattern" || memory.eventType === "diagnostic") {
    score += 2;
  }
  if (ERROR_LIKE_PATTERN.test(memory.summary) || ERROR_LIKE_PATTERN.test(memory.rawEvidence)) {
    score += 1;
  }
  return score;
}

function summarizeMemoryEvidence(memory: TraceMemory): string {
  if (!memory.rawEvidence) {
    return "No raw evidence attached.";
  }
  if (memory.eventType === "git_diff") {
    return "Raw git diff omitted from managed context by default.";
  }

  const snippet = ERROR_LIKE_PATTERN.test(memory.rawEvidence)
    ? firstMatchingLines(memory.rawEvidence, ERROR_LIKE_PATTERN)
    : memory.rawEvidence.trim().slice(0, MAX_SNIPPET_CHARACTERS);
  return fenced("text", snippet || memory.summary || "No concise evidence snippet available.");
}

function hasErrorLikeDiffLine(diff: string): boolean {
  return diff.split(/\r?\n/).some((line) => ERROR_LIKE_PATTERN.test(line));
}

function firstMatchingLines(value: string, pattern: RegExp): string {
  const lines = value.split(/\r?\n/);
  const snippets: string[] = [];
  for (const line of lines) {
    if (pattern.test(line)) {
      snippets.push(line.slice(0, 300));
    }
    if (snippets.join("\n").length >= MAX_SNIPPET_CHARACTERS) {
      break;
    }
  }
  return snippets.join("\n").slice(0, MAX_SNIPPET_CHARACTERS);
}

function fenced(language: string, content: string): string {
  const fence = content.includes("```") ? "````" : "```";
  return `${fence}${language}\n${content}\n${fence}`;
}
