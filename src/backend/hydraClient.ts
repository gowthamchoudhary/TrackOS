import { HydraDBClient } from "@hydradb/sdk";
import { TraceMemory, TraceMemoryEventType } from "../types/memory";

export const TENANT_ID =
  process.env.HYDRA_TENANT_ID?.trim() || "traceos";

export interface HydraConnection {
  client: HydraDBClient;
  tenantId: string;
  subTenantId: string;
}

interface HydraMemoryMetadata {
  event_type: TraceMemoryEventType;
  project: string;
  trace_id: string;
  tags: string[];
  importance: "low" | "medium" | "high";
  timestamp: string;
  file_path?: string;
  // FIX: store human label separately so summary isn't the raw ID
  label: string;
}

interface HydraMemoryItem {
  source_id: string;
  title: string;
  text: string;
  infer: boolean;
  metadata: HydraMemoryMetadata;
}

export function isHydraConfigured(): boolean {
  return Boolean(process.env.HYDRA_DB_API_KEY?.trim());
}

export function getHydraConnection(
  project: string,
  userId: string,
  teamId?: string
): HydraConnection {
  const token = process.env.HYDRA_DB_API_KEY?.trim();
  if (!token) {
    throw new Error("HYDRA_DB_API_KEY is not configured on the backend.");
  }

  const normalizedTeamId = teamId?.trim();
  return {
    client: new HydraDBClient({ token }),
    tenantId: TENANT_ID,
    subTenantId: normalizedTeamId
      ? `proj_${identifier(project)}__team_${identifier(normalizedTeamId)}`
      : `proj_${identifier(project)}__usr_${identifier(userId)}`
  };
}

export function buildHydraMemoryPayload(memories: TraceMemory[]): string {
  const items: HydraMemoryItem[] = memories.map((memory) => {
    const metadata: HydraMemoryMetadata = {
      event_type: memory.eventType,
      project: memory.project,
      trace_id: memory.id,
      tags: memory.tags ?? [],
      importance: memory.importance ?? "medium",
      timestamp: memory.timestamp,
      // FIX: store the human-readable label in metadata so we can recover it
      label: memory.label
    };

    if (memory.filePath) {
      metadata.file_path = memory.filePath;
    }

    return {
      source_id: memory.id,
      // FIX: title is the human label, not the ID
      title: memory.label,
      text: formatMemoryText(memory),
      infer: memory.infer,
      metadata
    };
  });

  return JSON.stringify(items);
}

export function logHydraIngestRequest(
  connection: HydraConnection,
  memories: string
): void {
  let parsedMemories: unknown;
  try {
    parsedMemories = JSON.parse(memories);
  } catch (error) {
    parsedMemories = {
      parseError: error instanceof Error ? error.message : String(error)
    };
  }

  const firstMemory = Array.isArray(parsedMemories)
    ? parsedMemories[0]
    : undefined;
  const firstMemoryObject =
    firstMemory && typeof firstMemory === "object"
      ? (firstMemory as Record<string, unknown>)
      : undefined;

  console.log("[TraceOS Backend] HydraDB ingest request details", {
    tenantId: connection.tenantId,
    tenant_id: connection.tenantId,
    subTenantId: connection.subTenantId,
    sub_tenant_id: connection.subTenantId,
    "typeof memories": typeof memories,
    "raw memories first 1000 chars": memories.slice(0, 1000),
    "parsed memories[0]": firstMemory,
    "typeof parsed memories[0].metadata": typeof firstMemoryObject?.metadata,
    "parsed memories[0].metadata value": firstMemoryObject?.metadata
  });
}

export function parseHydraMemories(
  response: Awaited<ReturnType<HydraDBClient["query"]>>,
  project: string,
  userId: string
): TraceMemory[] {
  const memories: TraceMemory[] = [];
  // FIX: deduplicate by trace_id — same session ID arriving multiple times
  // from HydraDB (e.g. bc1bc3ee:error appearing 4x) gets collapsed to one.
  const seenTraceIds = new Set<string>();

  for (const chunk of response.data?.chunks ?? []) {
    const metadata = chunk.metadata ?? {};
    const eventType = readEventType(metadata);
    if (!eventType || !chunk.chunkContent) {
      continue;
    }

    const traceId = readString(metadata.trace_id) || chunk.id;

    // FIX: skip duplicates — only keep the first occurrence of each trace_id
    if (seenTraceIds.has(traceId)) {
      continue;
    }
    seenTraceIds.add(traceId);

    const additionalMetadata = chunk.additionalMetadata ?? {};

    // FIX: recover the human-readable label from metadata.label first,
    // then fall back to sourceTitle, then the trace_id as last resort.
    const humanLabel =
      readString(metadata.label) ||
      readString(chunk.sourceTitle) ||
      traceId;

    // FIX: build a real summary from the chunk content rather than using
    // the raw ID. Extract the Summary section if present in the stored text.
    const recoveredSummary = extractSummarySection(chunk.chunkContent) ||
      humanLabel;

    memories.push({
      id: traceId,
      label: humanLabel,
      eventType,
      project: readString(metadata.project) || project,
      userId,
      // FIX: sanitize UTF-8 encoding corruption (double-encoded apostrophes etc.)
      rawEvidence: repairMojibake(chunk.chunkContent),
      summary: repairMojibake(recoveredSummary),
      filePath:
        readString(metadata.file_path) ||
        readString(additionalMetadata.file_path),
      tags:
        readStringArray(metadata.tags) ||
        readStringArray(additionalMetadata.tags),
      importance:
        readImportance(metadata.importance) ||
        readImportance(additionalMetadata.importance),
      infer: eventType === "pattern",
      timestamp:
        readString(metadata.timestamp) ||
        readString(additionalMetadata.timestamp) ||
        chunk.sourceUploadTime ||
        chunk.sourceLastUpdatedTime ||
        ""
    });
  }

  return memories;
}

function identifier(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized || "default";
}

function formatMemoryText(memory: TraceMemory): string {
  return [
    `# ${memory.label}`,
    "",
    "## Summary",
    "",
    // FIX: sanitize on the way in too so stored text is clean
    repairMojibake(memory.summary),
    "",
    "## Raw Evidence",
    "",
    fenced(repairMojibake(memory.rawEvidence))
  ].join("\n");
}

function fenced(content: string): string {
  const fence = content.includes("```") ? "````" : "```";
  return `${fence}text\n${content}\n${fence}`;
}

/**
 * FIX: Extract the "## Summary" section from stored memory text.
 * When we retrieve a chunk whose text was written by formatMemoryText,
 * we can pull out the human summary rather than returning the raw ID.
 */
function extractSummarySection(text: string): string | undefined {
  const match = text.match(/^## Summary\s*\n+([\s\S]*?)(?:\n+## |\n*$)/m);
  if (match && match[1]) {
    return match[1].trim();
  }
  return undefined;
}

function repairMojibake(value: string): string {
  if (!value || !looksLikeMojibake(value)) {
    return value;
  }

  let best = value;
  let candidate = value;
  for (let i = 0; i < 3; i += 1) {
    const decoded = decodeMojibakePass(candidate);
    if (!decoded || decoded === candidate) {
      break;
    }
    candidate = decoded;
    if (mojibakeScore(candidate) < mojibakeScore(best)) {
      best = candidate;
    }
  }

  return mojibakeScore(best) < mojibakeScore(value) ? best : value;
}

function looksLikeMojibake(value: string): boolean {
  return /[ÃÂâ]/.test(value);
}

function mojibakeScore(value: string): number {
  return (
    (value.match(/\uFFFD/g) ?? []).length * 5 +
    (value.match(/[ÃÂ]/g) ?? []).length * 2 +
    (value.match(/â/g) ?? []).length
  );
}

function decodeMojibakePass(value: string): string | undefined {
  const bytes: number[] = [];
  for (const char of value) {
    const byte = WINDOWS_1252_BYTES.get(char) ?? char.charCodeAt(0);
    if (byte < 0 || byte > 255) {
      return undefined;
    }
    bytes.push(byte);
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(
    Uint8Array.from(bytes)
  );
}

const WINDOWS_1252_BYTES = new Map<string, number>([
  ["€", 0x80],
  ["‚", 0x82],
  ["ƒ", 0x83],
  ["„", 0x84],
  ["…", 0x85],
  ["†", 0x86],
  ["‡", 0x87],
  ["ˆ", 0x88],
  ["‰", 0x89],
  ["Š", 0x8a],
  ["‹", 0x8b],
  ["Œ", 0x8c],
  ["Ž", 0x8e],
  ["‘", 0x91],
  ["’", 0x92],
  ["“", 0x93],
  ["”", 0x94],
  ["•", 0x95],
  ["–", 0x96],
  ["—", 0x97],
  ["˜", 0x98],
  ["™", 0x99],
  ["š", 0x9a],
  ["›", 0x9b],
  ["œ", 0x9c],
  ["ž", 0x9e],
  ["Ÿ", 0x9f]
]);

function readEventType(
  metadata: Record<string, unknown>
): TraceMemoryEventType | undefined {
  const value = readString(metadata.event_type);
  const validTypes: TraceMemoryEventType[] = [
    "failure",
    "fix",
    "diagnostic",
    "git_status",
    "git_diff",
    "terminal_log",
    "agent_output",
    "agent_error",
    "agent_command_failure",
    "constraint",
    "pattern"
  ];
  return validTypes.find((type) => type === value);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function readStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const strings = value.filter(
    (item): item is string => typeof item === "string"
  );
  return strings.length > 0 ? strings : undefined;
}

function readImportance(
  value: unknown
): TraceMemory["importance"] | undefined {
  return value === "low" || value === "medium" || value === "high"
    ? value
    : undefined;
}
