import * as vscode from "vscode";
import { WorkspaceInfo } from "../utils/workspace";

export type AgentId = "claude" | "codex" | "gemini" | "custom";

const AGENT_COMMANDS: Record<Exclude<AgentId, "custom">, string> = {
  claude: "claude",
  codex: "codex",
  gemini: "gemini"
};

export interface AgentLaunchResult {
  command: string;
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
  const terminal = vscode.window.createTerminal({
    name: "TraceOS Agent",
    cwd: workspace.rootPath
  });

  terminal.show(true);
  terminal.sendText(command, true);
  await delay(750);
  terminal.sendText(buildAgentPrompt(request), true);

  return { command };
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

function resolveAgentCommand(
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

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
