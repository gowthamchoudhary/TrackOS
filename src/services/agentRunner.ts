import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as fs, createWriteStream } from "node:fs";
import * as path from "node:path";
import { finished } from "node:stream/promises";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { AgentRunEvidence } from "../types/memory";
import { WorkspaceInfo } from "../utils/workspace";

export type AgentId = "claude" | "codex" | "gemini" | "custom";

interface AgentCommand {
  executable: string;
  configuredArgs: string[];
}

export type AgentRunResult =
  | {
      launched: false;
      command: string;
    }
  | {
      launched: true;
      evidence: AgentRunEvidence;
    };

interface SpawnCommand {
  executable: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
}

const execFileAsync = promisify(execFile);
const AGENT_COMMANDS: Record<Exclude<AgentId, "custom">, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini"
};
const PROMPT_FILE_INSTRUCTION =
  "Read .traceos/AGENT_PROMPT.md and follow the instructions in it.";
const ERROR_PATTERNS: ReadonlyArray<{
  label: string;
  pattern: RegExp;
}> = [
  { label: "error", pattern: /\berror\b/i },
  { label: "exception", pattern: /\bexception\b/i },
  { label: "failed", pattern: /\bfailed\b/i },
  { label: "traceback", pattern: /\btraceback\b/i },
  { label: "command not found", pattern: /command not found/i },
  { label: "compilation failed", pattern: /compilation failed/i },
  { label: "npm ERR!", pattern: /npm ERR!/i },
  { label: "TypeError", pattern: /\bTypeError\b/i },
  { label: "SyntaxError", pattern: /\bSyntaxError\b/i },
  { label: "Module not found", pattern: /module not found/i }
];

export class AgentRunner implements vscode.Disposable {
  private activeProcess: ReturnType<typeof spawn> | undefined;

  public constructor(private readonly output: vscode.OutputChannel) {}

  public async run(
    agentId: AgentId,
    workspace: WorkspaceInfo
  ): Promise<AgentRunResult> {
    if (this.activeProcess) {
      throw new Error("A TraceOS agent session is already running.");
    }

    const configuration = vscode.workspace.getConfiguration(
      "traceos",
      workspace.folder.uri
    );
    const command = resolveAgentCommand(agentId, configuration);
    const executable = await findExecutable(command.executable);
    if (!executable) {
      return {
        launched: false,
        command: command.executable
      };
    }

    await fs.mkdir(workspace.traceDirectory, { recursive: true });
    const logStream = createWriteStream(workspace.agentSessionLogFile, {
      encoding: "utf8",
      flags: "w"
    });
    const startedAt = new Date().toISOString();
    const stdoutChunks: string[] = [];
    const stderrChunks: string[] = [];
    const outputChunks: string[] = [];
    const args = [
      ...command.configuredArgs,
      ...builtInArguments(agentId)
    ];
    const spawnCommand = prepareSpawnCommand(executable, args);
    const displayCommand = [command.executable, ...args].join(" ");

    this.output.clear();
    this.output.show(true);
    this.output.appendLine(`[TraceOS] Starting ${displayCommand}`);
    this.output.appendLine(
      `[TraceOS] Capturing full stream in ${workspace.agentSessionLogFile}`
    );
    this.output.appendLine("");

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(spawnCommand.executable, spawnCommand.args, {
        cwd: workspace.rootPath,
        env: process.env,
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: spawnCommand.windowsVerbatimArguments,
        stdio: ["pipe", "pipe", "pipe"]
      });
      this.activeProcess = child;
    } catch (error) {
      const message = `[TraceOS] Failed to start agent: ${errorMessage(error)}\n`;
      logStream.end(message);
      this.output.append(message);
      await finished(logStream);
      return {
        launched: true,
        evidence: failedLaunchEvidence(
          agentId,
          displayCommand,
          startedAt,
          message
        )
      };
    }

    const capture = (chunk: Buffer, target: string[]): void => {
      const text = chunk.toString("utf8");
      target.push(text);
      outputChunks.push(text);
      logStream.write(text);
      this.output.append(text);
    };
    const childStdout = child.stdout;
    const childStderr = child.stderr;
    const childStdin = child.stdin;
    if (!childStdout || !childStderr || !childStdin) {
      child.kill();
      this.activeProcess = undefined;
      logStream.end();
      await finished(logStream);
      throw new Error("TraceOS could not open the agent process streams.");
    }

    childStdout.on("data", (chunk: Buffer) => capture(chunk, stdoutChunks));
    childStderr.on("data", (chunk: Buffer) => capture(chunk, stderrChunks));
    const exitPromise = waitForExit(child);

    childStdin.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code !== "EPIPE") {
        this.output.appendLine(
          `[TraceOS] Agent stdin error: ${error.message}`
        );
      }
    });
    childStdin.end(PROMPT_FILE_INSTRUCTION);

    const { exitCode, signal, spawnError } = await exitPromise;
    this.activeProcess = undefined;
    if (spawnError) {
      capture(
        Buffer.from(
          `[TraceOS] Failed to start agent: ${errorMessage(spawnError)}\n`
        ),
        stderrChunks
      );
    }
    logStream.end();
    await finished(logStream);

    const completedAt = new Date().toISOString();
    const output = outputChunks.join("");
    const errorPatterns = detectAgentErrorPatterns(output);

    this.output.appendLine("");
    this.output.appendLine(
      `[TraceOS] Agent exited with code ${String(exitCode)}${
        signal ? ` and signal ${signal}` : ""
      }.`
    );

    return {
      launched: true,
      evidence: {
        id: randomUUID(),
        agentId,
        command: displayCommand,
        startedAt,
        completedAt,
        exitCode,
        signal,
        stdout: stdoutChunks.join(""),
        stderr: stderrChunks.join(""),
        output,
        errorPatterns
      }
    };
  }

  public dispose(): void {
    if (this.activeProcess) {
      this.activeProcess.kill();
      this.activeProcess = undefined;
    }
  }
}

export function buildAgentPrompt(request: string): string {
  return [
    "Read .traceos/TRACEOS_CONTEXT.md first as exact project memory.",
    "",
    "User request:",
    request,
    "",
    "Rules:",
    "- Use only evidence from TraceOS context.",
    "- Do not invent missing errors.",
    "- Avoid repeated failures listed in the context.",
    "- Prefer relevant files listed in the context."
  ].join("\n");
}

export function detectAgentErrorPatterns(output: string): string[] {
  return ERROR_PATTERNS.filter(({ pattern }) => pattern.test(output)).map(
    ({ label }) => label
  );
}

function resolveAgentCommand(
  agentId: AgentId,
  configuration: vscode.WorkspaceConfiguration
): AgentCommand {
  const configured =
    agentId === "custom"
      ? configuration.get<string>("customAgentCommand", "").trim()
      : AGENT_COMMANDS[agentId];
  if (!configured) {
    throw new Error(
      "Set traceos.customAgentCommand before selecting Custom command."
    );
  }

  const [executable, ...configuredArgs] = parseCommandLine(configured);
  if (!executable) {
    throw new Error("The selected agent command has no executable.");
  }
  return { executable, configuredArgs };
}

function builtInArguments(agentId: AgentId): string[] {
  if (agentId === "claude") {
    return ["-p"];
  }
  if (agentId === "codex") {
    return ["exec", "-"];
  }
  if (agentId === "gemini") {
    return ["-p", ""];
  }
  return [];
}

async function findExecutable(command: string): Promise<string | undefined> {
  try {
    if (path.isAbsolute(command)) {
      await fs.access(command);
      return command;
    }

    if (process.platform === "win32") {
      const { stdout } = await execFileAsync("where.exe", [command], {
        windowsHide: true
      });
      const matches = stdout
        .split(/\r?\n/)
        .map((match) => match.trim())
        .filter(Boolean);
      return (
        matches.find((match) => path.extname(match).toLowerCase() === ".exe") ??
        matches.find((match) => path.extname(match).toLowerCase() === ".cmd") ??
        matches[0]
      );
    }

    const { stdout } = await execFileAsync(
      "/bin/sh",
      ["-c", 'command -v -- "$1"', "traceos", command],
      { windowsHide: true }
    );
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

function prepareSpawnCommand(
  executable: string,
  args: string[]
): SpawnCommand {
  if (
    process.platform !== "win32" ||
    path.extname(executable).toLowerCase() !== ".cmd"
  ) {
    return { executable, args };
  }

  const commandLine = [
    quoteCmdArgument(executable),
    ...args.map(quoteCmdArgument)
  ].join(" ");
  return {
    executable: process.env.ComSpec || "cmd.exe",
    args: ["/d", "/s", "/c", `"${commandLine}"`],
    windowsVerbatimArguments: true
  };
}

function quoteCmdArgument(value: string): string {
  return `"${value.replace(/"/g, '""')}"`;
}

function parseCommandLine(command: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;

  for (let index = 0; index < command.length; index += 1) {
    const character = command[index];
    if (quote) {
      if (character === quote) {
        quote = undefined;
      } else {
        current += character;
      }
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
      continue;
    }
    current += character;
  }

  if (quote) {
    throw new Error("The selected agent command contains an unclosed quote.");
  }
  if (current) {
    parts.push(current);
  }
  return parts;
}

function waitForExit(
  child: ReturnType<typeof spawn>
): Promise<{
  exitCode: number | null;
  signal: string | null;
  spawnError?: Error;
}> {
  return new Promise((resolve) => {
    let spawnError: Error | undefined;
    child.once("error", (error) => {
      spawnError = error;
    });
    child.once("close", (exitCode, signal) => {
      resolve({ exitCode, signal, spawnError });
    });
  });
}

function failedLaunchEvidence(
  agentId: AgentId,
  command: string,
  startedAt: string,
  message: string
): AgentRunEvidence {
  return {
    id: randomUUID(),
    agentId,
    command,
    startedAt,
    completedAt: new Date().toISOString(),
    exitCode: -1,
    signal: null,
    stdout: "",
    stderr: message,
    output: message,
    errorPatterns: detectAgentErrorPatterns(message)
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
