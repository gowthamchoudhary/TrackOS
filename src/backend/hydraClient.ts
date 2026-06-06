import { HydraDBClient } from "@hydradb/sdk";
import { TraceMemory, TraceMemoryEventType } from "../types/memory";

export const TENANT_ID =
  process.env.HYDRA_TENANT_ID?.trim() || "traceos";

export interface HydraConnection {
  client: HydraDBClient;
  tenantId: string;
  subTenantId: string;
}

export function isHydraConfigured(): boolean {
  return Boolean(process.env.HYDRA_DB_API_KEY?.trim());
}

export function getHydraConnection(
  project: string,
  userId: string
): HydraConnection {
  const token = process.env.HYDRA_DB_API_KEY?.trim();
  if (!token) {
    throw new Error("HYDRA_DB_API_KEY is not configured on the backend.");
  }

  return {
    client: new HydraDBClient({ token }),
    tenantId: TENANT_ID,
    subTenantId: `proj_${identifier(project)}__usr_${identifier(userId)}`
  };
}

export function buildHydraMemoryPayload(memories: TraceMemory[]): string {
  return JSON.stringify(
    memories.map((memory) => {
      const additionalMetadata: Record<string, unknown> = {
        tags: memory.tags ?? [],
        importance: memory.importance ?? "medium",
        timestamp: memory.timestamp
      };

      if (memory.filePath) {
        additionalMetadata.file_path = memory.filePath;
      }

      return {
        id: memory.id,
        label: memory.label,
        text: formatMemoryText(memory),
        is_markdown: true,
        infer: memory.infer,
        metadata: JSON.stringify({
          event_type: memory.eventType,
          project: memory.project
        }),
        additional_metadata: additionalMetadata,
        ...(memory.relatedIds?.length
          ? { relations: { ids: memory.relatedIds } }
          : {})
      };
    })
  );
}

export function parseHydraMemories(
  response: Awaited<ReturnType<HydraDBClient["query"]>>,
  project: string,
  userId: string
): TraceMemory[] {
  const memories: TraceMemory[] = [];

  for (const chunk of response.data?.chunks ?? []) {
    const metadata = chunk.metadata ?? {};
    const eventType = readEventType(metadata);
    if (!eventType || !chunk.chunkContent) {
      continue;
    }

    const additionalMetadata = chunk.additionalMetadata ?? {};
    memories.push({
      id: chunk.id,
      label: chunk.sourceTitle || chunk.id,
      eventType,
      project: readString(metadata.project) || project,
      userId,
      rawEvidence: chunk.chunkContent,
      summary: chunk.sourceTitle || chunk.chunkContent,
      filePath: readString(additionalMetadata.file_path),
      tags: readStringArray(additionalMetadata.tags),
      importance: readImportance(additionalMetadata.importance),
      infer: eventType === "pattern",
      timestamp:
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
    memory.summary,
    "",
    "## Raw Evidence",
    "",
    fenced(memory.rawEvidence)
  ].join("\n");
}

function fenced(content: string): string {
  const fence = content.includes("```") ? "````" : "```";
  return `${fence}text\n${content}\n${fence}`;
}

function readEventType(
  metadata: Record<string, unknown>
): TraceMemoryEventType | undefined {
  const value = readString(metadata.event_type);
  const validTypes: TraceMemoryEventType[] = [
    "failure",
    "fix",
    "diagnostic",
    "git_diff",
    "terminal_log",
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
