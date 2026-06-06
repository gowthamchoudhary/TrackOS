import { promises as fs } from "node:fs";

const MAX_TERMINAL_LINES = 200;

export async function collectTerminalLog(logFile: string): Promise<string> {
  try {
    const content = await fs.readFile(logFile, "utf8");
    const lines = content.split(/\r?\n/);
    return lines.slice(-MAX_TERMINAL_LINES).join("\n").trimEnd();
  } catch (error) {
    if (isMissingFile(error)) {
      return "";
    }

    throw error;
  }
}

function isMissingFile(error: unknown): error is NodeJS.ErrnoException {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}
