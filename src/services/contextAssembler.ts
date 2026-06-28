import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Worker } from "node:worker_threads";
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
const SKILLMAKE_TIMEOUT_MS = 3_000;
const SKILLMAKE_SYNC_WAIT_MS = SKILLMAKE_TIMEOUT_MS + 500;
const SKILLMAKE_KEYWORDS: Record<string, string> = {
  supabase: "supabase-agent-skills",
  next: "better-auth-nextjs",
  auth: "better-auth-nextjs",
  animation: "framer-motion",
  framer: "framer-motion",
  playwright: "playwright-skill",
  test: "mp-tdd",
  tdd: "mp-tdd",
  github: "claude-code-github-action",
  deploy: "cloudflare-workers-deploy",
  cloudflare: "cloudflare-workers-deploy",
  design: "anthropic-frontend-design",
  frontend: "anthropic-frontend-design",
  ui: "anthropic-frontend-design",
  linear: "linear-claude-skill",
  webhook: "hookdeck-webhook-skills",
  azure: "azure-deploy",
  shadcn: "shadcn-ui-skill"
};

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
    section("Current Git Status", formatGitStatus(current))
  ];

  if (shouldIncludeGitDiff(request, current)) {
    sections.push(section("Current Git Diff Summary", formatGitDiff(current)));
  }

  if (ERROR_LIKE_PATTERN.test(current.terminalLog)) {
    sections.push(
      section(
        "Recent Terminal Log Evidence",
        formatTerminalLog(current.terminalLog)
      )
    );
  }

  sections.push(
    section(
      "Repeated Diagnostics From Session",
      formatRepeatedDiagnostics(current.diagnostics, previousSnapshots)
    ),
    section("Decision Context — Relevant Past Experiences", formatMemories(recall)),
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
  );

  const skillmakeSkill = fetchSkillmakeSkillForContext(request);
  if (skillmakeSkill) {
    sections.push(
      section(
        "Skillmake Skill",
        [
          "The following skill was automatically fetched from Skillmake based on your request.",
          "Apply it alongside TraceOS memory.",
          "",
          skillmakeSkill
        ].join("\n")
      )
    );
  }

  return `${sections.join("\n\n")}\n`;
}

export async function fetchSkillmakeSkill(
  request: string
): Promise<string | undefined> {
  const skillName = findSkillmakeSkillName(request);
  if (!skillName) {
    return undefined;
  }

  try {
    return await httpsGet(
      `https://skillmake.xyz/i/${skillName}`,
      SKILLMAKE_TIMEOUT_MS
    );
  } catch {
    return undefined;
  }
}

function fetchSkillmakeSkillForContext(request: string): string | undefined {
  if (!findSkillmakeSkillName(request)) {
    return undefined;
  }

  const sharedBuffer = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(sharedBuffer);
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), "traceos-skillmake-"));
  const resultFile = path.join(tempDirectory, "result.json");
  const worker = new Worker(
    [
      'const { workerData } = require("node:worker_threads");',
      'const { writeFileSync } = require("node:fs");',
      "const state = new Int32Array(workerData.sharedBuffer);",
      "const { fetchSkillmakeSkill } = require(workerData.modulePath);",
      "fetchSkillmakeSkill(workerData.request)",
      "  .then((content) => {",
      "    writeFileSync(workerData.resultFile, JSON.stringify({ content }), \"utf8\");",
      "  })",
      "  .catch(() => {",
      "    writeFileSync(workerData.resultFile, JSON.stringify({}), \"utf8\");",
      "  })",
      "  .finally(() => {",
      "    Atomics.store(state, 0, 1);",
      "    Atomics.notify(state, 0);",
      "  });"
    ].join("\n"),
    {
      eval: true,
      workerData: {
        modulePath: __filename,
        request,
        resultFile,
        sharedBuffer
      }
    }
  );

  try {
    const waitResult = Atomics.wait(
      state,
      0,
      0,
      SKILLMAKE_SYNC_WAIT_MS
    );
    if (waitResult === "timed-out" || !existsSync(resultFile)) {
      return undefined;
    }

    const result = JSON.parse(readFileSync(resultFile, "utf8")) as {
      content?: unknown;
    };
    return typeof result.content === "string" && result.content.trim()
      ? result.content
      : undefined;
  } catch {
    return undefined;
  } finally {
    void worker.terminate();
    rmSync(tempDirectory, { recursive: true, force: true });
  }
}

function findSkillmakeSkillName(request: string): string | undefined {
  const normalizedRequest = request.toLowerCase();
  return Object.entries(SKILLMAKE_KEYWORDS).find(([keyword]) =>
    normalizedRequest.includes(keyword)
  )?.[1];
}

function httpsGet(url: string, timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const https = require("node:https") as typeof import("node:https");
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        if (res.headers.location) {
          httpsGet(res.headers.location, timeoutMs).then(resolve).catch(reject);
          return;
        }
      }
      if (res.statusCode && res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      res.on("error", reject);
    });
    req.on("timeout", () => {
      req.destroy();
      reject(new Error("timeout"));
    });
    req.on("error", reject);
  });
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
    return "No relevant past experiences found for this request.";
  }

  const memories = recall.memories
    .filter(isRelevantMemory)
    .sort(memoryPriority)
    .slice(0, 5);

  if (memories.length === 0) {
    return "No relevant past experiences found for this request.";
  }

  return memories.map(formatMemory).join("\n\n");
}

function formatMemory(memory: TraceMemory): string {
  const lines: string[] = [];

  // Header based on event type
  if (memory.eventType === "agent_error" || memory.eventType === "agent_command_failure") {
    lines.push(`### ⚠️ Previous Attempt — ${memory.label}`);
  } else if (memory.eventType === "pattern") {
    lines.push(`### 🔁 Repeated Issue — ${memory.label}`);
  } else if (memory.eventType === "diagnostic") {
    lines.push(`### 🔴 Known Diagnostic — ${memory.label}`);
  } else {
    lines.push(`### ${memory.label}`);
  }

  lines.push("");
  lines.push(`* Event type: ${memory.eventType}`);
  lines.push(`* Timestamp: ${memory.timestamp || "Not provided."}`);
  if (memory.filePath) {
    lines.push(`* File: ${memory.filePath}`);
  }

  // If rawEvidence looks like a structured lesson (contains "type:" and "outcome:")
  // render it directly as decision context
  if (memory.rawEvidence && memory.rawEvidence.includes("outcome:") && memory.rawEvidence.includes("type:")) {
    lines.push("");
    lines.push("**Decision Context:**");
    lines.push("");
    lines.push("```");
    lines.push(memory.rawEvidence.trim());
    lines.push("```");
  } else {
    // Fall back to summary + snippet for non-lesson memories
    if (memory.summary) {
      lines.push(`* Summary: ${memory.summary}`);
    }
    lines.push("");
    const evidence = summarizeMemoryEvidence(memory);
    lines.push(evidence);
  }

  return lines.filter((line): line is string => line !== undefined).join("\n");
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

function shouldIncludeGitDiff(request: string, snapshot: Snapshot): boolean {
  if (!snapshot.git.diff && !snapshot.git.diffStat) {
    return false;
  }
  return (
    snapshot.git.changedFiles.some((filePath) =>
      isRequestRelated(request, filePath)
    ) || hasErrorLikeDiffLine(snapshot.git.diff)
  );
}

function isRequestRelated(request: string, filePath: string): boolean {
  const normalizedFilePath = filePath.toLowerCase();
  return request
    .toLowerCase()
    .split(/[^a-z0-9_-]+/)
    .filter((word) => word.length > 4)
    .some((word) => normalizedFilePath.includes(word));
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
