import { promises as fs } from "node:fs";
import { SessionData, Snapshot } from "../types/snapshot";
import { WorkspaceInfo } from "../utils/workspace";

const MAX_SNAPSHOTS = 50;

export class SessionStore {
  private appendQueue: Promise<void> = Promise.resolve();

  public constructor(private readonly workspace: WorkspaceInfo) {}

  public async initialize(): Promise<void> {
    await fs.mkdir(this.workspace.traceDirectory, { recursive: true });
    await createFileIfMissing(this.workspace.terminalLogFile, "");

    const initialSession: SessionData = {
      version: 1,
      workspace: this.workspace.name,
      snapshots: []
    };

    await createFileIfMissing(
      this.workspace.sessionFile,
      `${JSON.stringify(initialSession, null, 2)}\n`
    );
  }

  public async read(): Promise<SessionData> {
    await this.initialize();
    const raw = await fs.readFile(this.workspace.sessionFile, "utf8");
    const parsed: unknown = JSON.parse(raw);

    if (!isSessionData(parsed)) {
      throw new Error(
        `${this.workspace.sessionFile} is not a valid TraceOS session file.`
      );
    }

    return parsed;
  }

  public async append(snapshot: Snapshot): Promise<SessionData> {
    const operation = this.appendQueue.then(async () => {
      const session = await this.read();
      session.workspace = this.workspace.name;
      session.snapshots = [...session.snapshots, snapshot].slice(-MAX_SNAPSHOTS);
      await writeJsonAtomically(this.workspace.sessionFile, session);
      return session;
    });
    this.appendQueue = operation.then(
      () => undefined,
      () => undefined
    );
    return operation;
  }
}

async function createFileIfMissing(
  filePath: string,
  content: string
): Promise<void> {
  try {
    await fs.writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if (!isExistingFile(error)) {
      throw error;
    }
  }
}

async function writeJsonAtomically(
  filePath: string,
  data: SessionData
): Promise<void> {
  const temporaryPath = `${filePath}.tmp`;
  await fs.writeFile(
    temporaryPath,
    `${JSON.stringify(data, null, 2)}\n`,
    "utf8"
  );
  await fs.rename(temporaryPath, filePath);
}

function isSessionData(value: unknown): value is SessionData {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SessionData>;
  return (
    candidate.version === 1 &&
    typeof candidate.workspace === "string" &&
    Array.isArray(candidate.snapshots)
  );
}

function isExistingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "EEXIST"
  );
}
