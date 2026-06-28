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

function analyzeProjectDependencies(workspaceRoot: string): string[] {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const pkgPath = path.join(workspaceRoot, "package.json");
    if (!fs.existsSync(pkgPath)) return [];
    const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const allDeps = {
      ...(pkg.dependencies ?? {}),
      ...(pkg.devDependencies ?? {})
    };
    const depToSkill: Record<string, string> = {
      "@supabase/supabase-js": "supabase-agent-skills",
      "supabase": "supabase-agent-skills",
      "shadcn": "shadcn-ui-skill",
      "@shadcn/ui": "shadcn-ui-skill",
      "framer-motion": "framer-motion",
      "playwright": "playwright-skill",
      "@playwright/test": "playwright-skill",
      "better-auth": "better-auth-nextjs",
      "next-auth": "better-auth-nextjs",
      "tailwindcss": "anthropic-frontend-design",
      "next": "anthropic-frontend-design",
      "@anthropic-ai/sdk": "claude-api",
      "anthropic": "claude-api",
      "vitest": "mp-tdd",
      "jest": "mp-tdd"
    };
    const detected: string[] = [];
    for (const dep of Object.keys(allDeps)) {
      const skill = depToSkill[dep];
      if (skill && !detected.includes(skill)) {
        detected.push(skill);
      }
    }
    return detected;
  } catch {
    return [];
  }
}

function getSkillCacheDir(): string {
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const fs = require("node:fs") as typeof import("node:fs");
  const dir = path.join(os.homedir(), ".traceos", "skills");
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getCachedOrFetchSkill(skillName: string): string | undefined {
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    const cacheDir = getSkillCacheDir();
    const cachePath = path.join(cacheDir, `${skillName}.md`);
    const metaPath = path.join(cacheDir, `${skillName}.meta.json`);
    const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

    // Check if cached and fresh
    if (fs.existsSync(cachePath) && fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { fetchedAt: number };
      if (Date.now() - meta.fetchedAt < CACHE_TTL_MS) {
        return fs.readFileSync(cachePath, "utf8");
      }
    }

    // Fetch from Skillmake synchronously using child_process
    const { execFileSync } = require("node:child_process") as typeof import("node:child_process");
    let content: string;
    try {
      content = execFileSync("curl", [
        "--silent",
        "--fail",
        "--max-time", "5",
        "--location",
        `https://skillmake.xyz/i/${skillName}`
      ], { encoding: "utf8" });
    } catch {
      return undefined;
    }

    if (!content || content.length < 50) return undefined;

    // Cache it
    fs.writeFileSync(cachePath, content, "utf8");
    fs.writeFileSync(metaPath, JSON.stringify({ fetchedAt: Date.now() }), "utf8");

    return content;
  } catch {
    return undefined;
  }
}

function buildSkillReport(
  workspaceRoot: string,
  userRequest: string
): { reportSection: string; skillsContent: string } {
  const detected = analyzeProjectDependencies(workspaceRoot);

  // Also check user request for additional skill hints
  const requestLower = userRequest.toLowerCase();
  const requestSkillMap: Record<string, string> = {
    "supabase": "supabase-agent-skills",
    "shadcn": "shadcn-ui-skill",
    "framer": "framer-motion",
    "playwright": "playwright-skill",
    "auth": "better-auth-nextjs",
    "tailwind": "anthropic-frontend-design",
    "frontend": "anthropic-frontend-design",
    "ui": "anthropic-frontend-design",
    "test": "mp-tdd",
    "tdd": "mp-tdd",
    "diagnose": "mp-diagnose",
    "debug": "mp-diagnose",
    "claude": "claude-api",
    "anthropic": "claude-api"
  };
  const fromRequest: string[] = [];
  for (const [keyword, skill] of Object.entries(requestSkillMap)) {
    if (requestLower.includes(keyword) && !detected.includes(skill)) {
      fromRequest.push(skill);
    }
  }
  const allSkills = [...new Set([...detected, ...fromRequest])];

  if (allSkills.length === 0) {
    return { reportSection: "", skillsContent: "" };
  }

  // Resolve each skill - cached or fresh
  const results: Array<{ skill: string; status: "cached" | "downloaded" | "unavailable"; content?: string }> = [];
  for (const skill of allSkills) {
    const content = getCachedOrFetchSkill(skill);
    const cacheDir = getSkillCacheDir();
    const path = require("node:path") as typeof import("node:path");
    const fs = require("node:fs") as typeof import("node:fs");
    const metaPath = path.join(cacheDir, `${skill}.meta.json`);
    let status: "cached" | "downloaded" | "unavailable";
    if (!content) {
      status = "unavailable";
    } else if (fs.existsSync(metaPath)) {
      const meta = JSON.parse(fs.readFileSync(metaPath, "utf8")) as { fetchedAt: number };
      const age = Date.now() - meta.fetchedAt;
      status = age < 5000 ? "downloaded" : "cached"; // downloaded if fetched in last 5 seconds
    } else {
      status = "downloaded";
    }
    results.push({ skill, status, content: content ?? undefined });
  }

  // Build the report block
  const detectedList = detected.length > 0
    ? detected.map(s => `  ✓ ${s} (from package.json)`).join("\n")
    : "  (none detected)";
  const requestList = fromRequest.length > 0
    ? fromRequest.map(s => `  ✓ ${s} (from request keywords)`).join("\n")
    : "";
  const skillStatusList = results
    .map(r => {
      const icon = r.status === "unavailable" ? "✗" : "✓";
      const label = r.status === "cached" ? "cached" : r.status === "downloaded" ? "downloaded" : "unavailable";
      return `  ${icon} ${r.skill} (${label})`;
    })
    .join("\n");

  const reportSection = [
    "## Skillmake - Project Skill Analysis",
    "",
    "**Detected from package.json:**",
    detectedList,
    requestList ? `\n**Detected from request:**\n${requestList}` : "",
    "",
    "**Skills loaded:**",
    skillStatusList,
    ""
  ].filter(l => l !== undefined).join("\n");

  // Combine all available skill content
  const skillsContent = results
    .filter(r => r.content)
    .map(r => `### Skillmake: ${r.skill}\n\n${r.content}`)
    .join("\n\n---\n\n");

  return { reportSection, skillsContent };
}

export function assembleContext(
  request: string,
  current: Snapshot,
  previousSnapshots: Snapshot[],
  recall: MemoryRecallResult
): string {
  const workspaceRoot = current.workspacePath;
  const { reportSection, skillsContent } = buildSkillReport(workspaceRoot, request);
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
    )
  ];

  if (reportSection) {
    sections.push(reportSection);
  }

  sections.push(
    section("Current Exact Diagnostics", formatDiagnostics(current.diagnostics)),
    section("Current Git Status", formatGitStatus(current))
  );

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

  if (skillsContent) {
    sections.push(
      section(
        "Skillmake Skills - Loaded for This Session",
        skillsContent
      )
    );
  }

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
