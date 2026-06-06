export type TraceMemoryEventType =
  | "failure"
  | "fix"
  | "diagnostic"
  | "git_status"
  | "git_diff"
  | "terminal_log"
  | "constraint"
  | "pattern";

export interface TraceMemory {
  id: string;
  label: string;
  eventType: TraceMemoryEventType;
  project: string;
  userId: string;
  rawEvidence: string;
  summary: string;
  filePath?: string;
  tags?: string[];
  importance?: "low" | "medium" | "high";
  relatedIds?: string[];
  infer: boolean;
  timestamp: string;
}

export interface MemoryRecallResult {
  memories: TraceMemory[];
  hydraAvailable: boolean;
  message?: string;
}

export interface MemoryIngestionResult {
  received: {
    diagnostics: number;
    gitStatusLength: number;
    gitDiffLength: number;
    terminalLogLength: number;
  };
  attempted: number;
  ingested: number;
  skippedReasons: string[];
  backendAvailable: boolean;
  message: string;
}

export interface BackendHealthResult {
  success: boolean;
  hydraConfigured: boolean;
  message: string;
}
