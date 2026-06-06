import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { GitEvidence } from "../types/snapshot";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 10 * 1024 * 1024;

export async function collectGitEvidence(
  workspacePath: string
): Promise<GitEvidence> {
  try {
    const [status, diffStat, diff] = await Promise.all([
      runGit(workspacePath, ["status", "--short"]),
      runGit(workspacePath, ["diff", "--stat"]),
      runGit(workspacePath, ["diff"])
    ]);

    return {
      status,
      changedFiles: parseChangedFiles(status),
      diffStat,
      diff
    };
  } catch (error) {
    return {
      status: "",
      changedFiles: [],
      diffStat: "",
      diff: "",
      error: errorMessage(error)
    };
  }
}

async function runGit(
  workspacePath: string,
  args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: workspacePath,
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    windowsHide: true
  });

  return stdout.trimEnd();
}

function parseChangedFiles(status: string): string[] {
  if (!status) {
    return [];
  }

  return status
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.slice(3).trim())
    .map((file) => {
      const renameParts = file.split(" -> ");
      return renameParts[renameParts.length - 1];
    });
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}
