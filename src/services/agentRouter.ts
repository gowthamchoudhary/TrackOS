import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import { WorkspaceInfo } from "../utils/workspace";

export type AgentId = "claude" | "codex" | "gemini" | "custom";

const execFileAsync = promisify(execFile);
const AGENT_COMMANDS: Record<Exclude<AgentId, "custom">, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini"
};

export interface AgentLaunchResult {
  command: string;
  launched: boolean;
  autoSubmitted: boolean;
}

export async function launchAgent(
  agentId: AgentId,
  request: string,
  workspace: WorkspaceInfo
): Promise<AgentLaunchResult> {
  const configuration = vscode.workspace.getConfiguration(
    "traceos",
    workspace.folder.uri
  );
  const command = resolveAgentCommand(agentId, configuration);
  if (!(await isCommandAvailable(command))) {
    return {
      command,
      launched: false,
      autoSubmitted: false
    };
  }

  const autoSubmit = configuration.get<boolean>("autoSubmitPrompt", false);
  const terminal = vscode.window.createTerminal({
    name: "TraceOS Agent",
    cwd: workspace.rootPath
  });

  terminal.show(true);
  terminal.sendText(command, true);
  await delay(750);
  terminal.sendText(buildAgentPrompt(request), autoSubmit);

  return {
    command,
    launched: true,
    autoSubmitted: autoSubmit
  };
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

export function resolveAgentCommand(
  agentId: AgentId,
  configuration: vscode.WorkspaceConfiguration
): string {
  if (agentId !== "custom") {
    return AGENT_COMMANDS[agentId];
  }

  const customCommand = configuration
    .get<string>("customAgentCommand", "")
    .trim();
  if (!customCommand) {
    throw new Error(
      "Set traceos.customAgentCommand before selecting Custom command."
    );
  }

  return customCommand;
}

export async function isCommandAvailable(command: string): Promise<boolean> {
  const executable = commandExecutable(command);
  if (!executable) {
    return false;
  }

  try {
    if (process.platform === "win32") {
      await execFileAsync("where", [executable], { windowsHide: true });
    } else {
      await execFileAsync(
        "/bin/sh",
        ["-c", 'command -v -- "$1"', "traceos", executable],
        { windowsHide: true }
      );
    }
    return true;
  } catch {
    return false;
  }
}

function commandExecutable(command: string): string {
  const trimmed = command.trim();
  const quote = trimmed[0];
  if (quote === '"' || quote === "'") {
    const closingIndex = trimmed.indexOf(quote, 1);
    return closingIndex > 1 ? trimmed.slice(1, closingIndex) : "";
  }

  return trimmed.split(/\s+/, 1)[0] ?? "";
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
