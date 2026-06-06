import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { DiagnosticEvidence, Snapshot } from "../types/snapshot";

interface Observation {
  snapshotIds: string[];
}

interface RegistryData {
  version: 1;
  observations: Record<string, Observation>;
}

export interface RepeatedDiagnostic {
  diagnostic: DiagnosticEvidence;
  observedSnapshotCount: number;
}

export class DiagnosticRegistry {
  private readonly filePath: string;

  public constructor() {
    const directory =
      process.env.TRACEOS_DATA_DIR?.trim() ||
      path.resolve(process.cwd(), ".traceos-backend");
    this.filePath = path.join(directory, "diagnostic-observations.json");
  }

  public async findRepeated(
    project: string,
    userId: string,
    snapshot: Snapshot
  ): Promise<RepeatedDiagnostic[]> {
    const data = await this.read();
    return snapshot.diagnostics.flatMap((diagnostic) => {
      const observation = data.observations[
        observationKey(project, userId, diagnostic)
      ];
      const previousCount = observation?.snapshotIds.filter(
        (id) => id !== snapshot.id
      ).length ?? 0;
      return previousCount > 0
        ? [{
            diagnostic,
            observedSnapshotCount: previousCount + 1
          }]
        : [];
    });
  }

  public async record(
    project: string,
    userId: string,
    snapshot: Snapshot
  ): Promise<void> {
    const data = await this.read();

    for (const diagnostic of snapshot.diagnostics) {
      const key = observationKey(project, userId, diagnostic);
      const observation = data.observations[key] ?? { snapshotIds: [] };
      if (!observation.snapshotIds.includes(snapshot.id)) {
        observation.snapshotIds.push(snapshot.id);
      }
      data.observations[key] = observation;
    }

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    await fs.writeFile(
      temporaryPath,
      `${JSON.stringify(data, null, 2)}\n`,
      "utf8"
    );
    await fs.rename(temporaryPath, this.filePath);
  }

  private async read(): Promise<RegistryData> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as Partial<RegistryData>;
      if (
        parsed.version === 1 &&
        parsed.observations &&
        typeof parsed.observations === "object"
      ) {
        return parsed as RegistryData;
      }
    } catch (error) {
      if (!isMissingFile(error)) {
        throw error;
      }
    }

    return { version: 1, observations: {} };
  }
}

function observationKey(
  project: string,
  userId: string,
  diagnostic: DiagnosticEvidence
): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        project,
        userId,
        diagnostic.filePath,
        diagnostic.line,
        diagnostic.character,
        diagnostic.severity,
        diagnostic.message,
        diagnostic.source ?? "",
        diagnostic.code ?? ""
      ])
    )
    .digest("hex");
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
