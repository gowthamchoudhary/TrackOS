import { createServer, IncomingMessage, ServerResponse } from "node:http";
import { assembleContext } from "../services/contextAssembler";
import { AgentRunEvidence } from "../types/memory";
import { Snapshot } from "../types/snapshot";
import { DiagnosticRegistry } from "./diagnosticRegistry";
import { isHydraConfigured } from "./hydraClient";
import {
  ingestAgentOutput,
  ingestMemory,
  recallRelevantContext
} from "./memoryService";

const PORT = readPort(process.env.PORT);
const MAX_BODY_BYTES = 10 * 1024 * 1024;
const registry = new DiagnosticRegistry();

interface IngestBody {
  userId: string;
  project: string;
  workspaceName: string;
  snapshot: Snapshot;
}

interface AssembleBody {
  userId: string;
  project: string;
  request: string;
  snapshot: Snapshot;
}

interface AgentOutputBody {
  userId: string;
  project: string;
  evidence: AgentRunEvidence;
}

const server = createServer(async (request, response) => {
  try {
    await route(request, response);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[TraceOS Backend] ${message}`);
    sendJson(response, 500, { ok: false, message });
  }
});

server.listen(PORT, () => {
  console.log(`[TraceOS Backend] Listening on http://localhost:${PORT}`);
  console.log(
    `[TraceOS Backend] HydraDB configured: ${isHydraConfigured()}`
  );
});

async function route(
  request: IncomingMessage,
  response: ServerResponse
): Promise<void> {
  const method = request.method ?? "GET";
  const path = new URL(request.url ?? "/", "http://localhost").pathname;

  if (method === "GET" && path === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      hydraConfigured: isHydraConfigured()
    });
    return;
  }

  if (method === "POST" && path === "/api/memory/ingest") {
    const body = requireIngestBody(await readJson(request));
    console.log(
      [
        "[TraceOS Backend] Ingest request",
        `userId=${body.userId}`,
        `project=${body.project}`,
        `workspaceName=${body.workspaceName}`,
        `diagnostics=${body.snapshot.diagnostics.length}`,
        `gitStatusLength=${body.snapshot.git.status.length}`,
        `gitDiffLength=${body.snapshot.git.diff.length}`,
        `terminalLogLength=${body.snapshot.terminalLog.length}`
      ].join(" ")
    );
    const result = await ingestMemory(
      body.userId,
      body.project,
      body.snapshot,
      registry
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === "POST" && path === "/api/memory/agent-output") {
    const body = requireAgentOutputBody(await readJson(request));
    console.log(
      [
        "[TraceOS Backend] Agent output request",
        `userId=${body.userId}`,
        `project=${body.project}`,
        `agent=${body.evidence.agentId}`,
        `outputLength=${body.evidence.output.length}`,
        `stderrLength=${body.evidence.stderr.length}`,
        `exitCode=${String(body.evidence.exitCode)}`
      ].join(" ")
    );
    const result = await ingestAgentOutput(
      body.userId,
      body.project,
      body.evidence
    );
    sendJson(response, 200, { ok: true, ...result });
    return;
  }

  if (method === "POST" && path === "/api/context/assemble") {
    const body = requireAssembleBody(await readJson(request));
    const recall = await recallRelevantContext(
      body.userId,
      body.project,
      body.request,
      body.snapshot
    );
    const markdown = assembleContext(
      body.request,
      body.snapshot,
      [],
      recall
    );
    sendJson(response, 200, { ok: true, markdown });
    return;
  }

  sendJson(response, 404, { ok: false, message: "Route not found." });
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds the 10 MB limit.");
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON.");
  }
}

function requireIngestBody(value: unknown): IngestBody {
  const body = requireObject(value);
  if (
    !isNonEmptyString(body.userId) ||
    !isNonEmptyString(body.project) ||
    !isNonEmptyString(body.workspaceName) ||
    !isSnapshot(body.snapshot)
  ) {
    throw new Error("Invalid memory ingestion request.");
  }
  return body as unknown as IngestBody;
}

function requireAssembleBody(value: unknown): AssembleBody {
  const body = requireObject(value);
  if (
    !isNonEmptyString(body.userId) ||
    !isNonEmptyString(body.project) ||
    !isNonEmptyString(body.request) ||
    !isSnapshot(body.snapshot)
  ) {
    throw new Error("Invalid context assembly request.");
  }
  return body as unknown as AssembleBody;
}

function requireAgentOutputBody(value: unknown): AgentOutputBody {
  const body = requireObject(value);
  if (
    !isNonEmptyString(body.userId) ||
    !isNonEmptyString(body.project) ||
    !isAgentRunEvidence(body.evidence)
  ) {
    throw new Error("Invalid agent output ingestion request.");
  }
  return body as unknown as AgentOutputBody;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value as Record<string, unknown>;
}

function isSnapshot(value: unknown): value is Snapshot {
  if (!value || typeof value !== "object") {
    return false;
  }
  const snapshot = value as Partial<Snapshot>;
  return (
    isNonEmptyString(snapshot.id) &&
    isNonEmptyString(snapshot.timestamp) &&
    isNonEmptyString(snapshot.workspaceName) &&
    isNonEmptyString(snapshot.workspacePath) &&
    Array.isArray(snapshot.diagnostics) &&
    Boolean(snapshot.git) &&
    typeof snapshot.terminalLog === "string" &&
    Array.isArray(snapshot.events)
  );
}

function isAgentRunEvidence(value: unknown): value is AgentRunEvidence {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const evidence = value as Partial<AgentRunEvidence>;
  return (
    isNonEmptyString(evidence.id) &&
    isNonEmptyString(evidence.agentId) &&
    isNonEmptyString(evidence.command) &&
    isNonEmptyString(evidence.startedAt) &&
    isNonEmptyString(evidence.completedAt) &&
    (typeof evidence.exitCode === "number" || evidence.exitCode === null) &&
    (typeof evidence.signal === "string" || evidence.signal === null) &&
    typeof evidence.stdout === "string" &&
    typeof evidence.stderr === "string" &&
    typeof evidence.output === "string" &&
    Array.isArray(evidence.errorPatterns) &&
    evidence.errorPatterns.every((pattern) => typeof pattern === "string")
  );
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function sendJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function readPort(value: string | undefined): number {
  const parsed = Number(value ?? "8000");
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 8000;
}
