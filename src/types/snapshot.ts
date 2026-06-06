export interface DiagnosticEvidence {
  filePath: string;
  line: number;
  character: number;
  severity: string;
  message: string;
  source?: string;
  code?: string;
}

export interface GitEvidence {
  status: string;
  changedFiles: string[];
  diffStat: string;
  diff: string;
  error?: string;
}

export type CaptureEventType =
  | "diagnosticsChanged"
  | "documentSaved"
  | "activeEditorChanged"
  | "workspaceChanged"
  | "terminalLogChanged";

export interface CaptureEvent {
  type: CaptureEventType;
  timestamp: string;
  detail?: string;
}

export interface Snapshot {
  id: string;
  timestamp: string;
  workspaceName: string;
  workspacePath: string;
  activeFile?: string;
  diagnostics: DiagnosticEvidence[];
  git: GitEvidence;
  terminalLog: string;
  events: CaptureEvent[];
}

export interface SessionData {
  version: 1;
  workspace: string;
  snapshots: Snapshot[];
}
