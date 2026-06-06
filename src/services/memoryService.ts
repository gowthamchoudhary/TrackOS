import * as vscode from "vscode";
import {
  BackendHealthResult,
  MemoryIngestionResult
} from "../types/memory";
import { Snapshot } from "../types/snapshot";
import { WorkspaceInfo } from "../utils/workspace";

const BACKEND_UNAVAILABLE =
  "TraceOS backend unavailable. Running local context only.";
const REQUEST_TIMEOUT_MS = 10_000;
const DEFAULT_BACKEND_URL = "https://trackos-h16r.onrender.com";

interface IngestResponse {
  ok: boolean;
  received: MemoryIngestionResult["received"];
  attempted: number;
  ingested: number;
  skippedReasons: string[];
  message: string;
}

interface AssembleResponse {
  ok: boolean;
  markdown: string;
}

interface HealthResponse {
  ok: boolean;
  hydraConfigured: boolean;
}

export async function ingestMemory(
  snapshot: Snapshot,
  workspace: WorkspaceInfo
): Promise<MemoryIngestionResult> {
  try {
    const response = await postJson<IngestResponse>(
      workspace,
      "/api/memory/ingest",
      {
        userId: getUserId(workspace),
        project: workspace.name,
        workspaceName: snapshot.workspaceName,
        snapshot
      }
    );

    return {
      received: response.received,
      attempted: response.attempted,
      ingested: response.ingested,
      skippedReasons: response.skippedReasons,
      backendAvailable: true,
      message: response.message
    };
  } catch (error) {
    console.error(`[TraceOS] Backend ingestion failed: ${errorMessage(error)}`);
    return {
      received: evidenceCounts(snapshot),
      attempted: 0,
      ingested: 0,
      skippedReasons: [errorMessage(error)],
      backendAvailable: false,
      message: `${BACKEND_UNAVAILABLE} ${errorMessage(error)}`
    };
  }
}

export async function assembleManagedContext(
  request: string,
  snapshot: Snapshot,
  workspace: WorkspaceInfo
): Promise<string | undefined> {
  try {
    const response = await postJson<AssembleResponse>(
      workspace,
      "/api/context/assemble",
      {
        userId: getUserId(workspace),
        project: workspace.name,
        request,
        snapshot
      }
    );
    return response.markdown;
  } catch (error) {
    console.error(`[TraceOS] Backend context failed: ${errorMessage(error)}`);
    return undefined;
  }
}

export async function testBackend(
  workspace: WorkspaceInfo
): Promise<BackendHealthResult> {
  try {
    const response = await requestJson<HealthResponse>(
      workspace,
      "/api/health",
      { method: "GET" }
    );
    return {
      success: response.ok,
      hydraConfigured: response.hydraConfigured,
      message: response.hydraConfigured
        ? "TraceOS backend is healthy and managed memory is configured."
        : "TraceOS backend is healthy, but managed memory is not configured."
    };
  } catch (error) {
    return {
      success: false,
      hydraConfigured: false,
      message: `${BACKEND_UNAVAILABLE} ${errorMessage(error)}`
    };
  }
}

export function backendUnavailableMessage(): string {
  return BACKEND_UNAVAILABLE;
}

async function postJson<T>(
  workspace: WorkspaceInfo,
  path: string,
  body: unknown
): Promise<T> {
  return requestJson<T>(workspace, path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
}

async function requestJson<T>(
  workspace: WorkspaceInfo,
  path: string,
  init: RequestInit
): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(`${getBackendUrl(workspace)}${path}`, {
      ...init,
      signal: controller.signal
    });
    const payload = (await response.json()) as T & { message?: string };
    if (!response.ok) {
      throw new Error(payload.message || `HTTP ${response.status}`);
    }
    return payload;
  } finally {
    clearTimeout(timeout);
  }
}

function getBackendUrl(workspace: WorkspaceInfo): string {
  const configured = vscode.workspace
    .getConfiguration("traceos", workspace.folder.uri)
    .get<string>("backendUrl", DEFAULT_BACKEND_URL)
    .trim();
  return (configured || DEFAULT_BACKEND_URL).replace(/\/+$/, "");
}

function getUserId(workspace: WorkspaceInfo): string {
  return (
    vscode.workspace
      .getConfiguration("traceos", workspace.folder.uri)
      .get<string>("userId", "local_user")
      .trim() || "local_user"
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function evidenceCounts(
  snapshot: Snapshot
): MemoryIngestionResult["received"] {
  return {
    diagnostics: snapshot.diagnostics.length,
    gitStatusLength: snapshot.git.status.length,
    gitDiffLength: snapshot.git.diff.length,
    terminalLogLength: snapshot.terminalLog.length
  };
}
