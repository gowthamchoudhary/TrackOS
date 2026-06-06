import * as vscode from "vscode";
import { AgentId } from "../services/agentRouter";

interface RunRequestMessage {
  type: "run";
  request: string;
  agentId: AgentId;
}

export type TraceosRunHandler = (
  request: string,
  agentId: AgentId
) => Promise<string>;

export class TraceosViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "traceos.sidebar";

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runHandler: TraceosRunHandler
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = getHtml(webviewView.webview);
    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRunRequest(message)) {
        return;
      }

      const request = message.request.trim();
      if (!request) {
        await postStatus(webviewView.webview, "error", "Enter a request first.");
        return;
      }

      await postStatus(
        webviewView.webview,
        "running",
        "Capturing evidence and preparing TraceOS memory..."
      );

      try {
        const status = await this.runHandler(request, message.agentId);
        await postStatus(webviewView.webview, "success", status);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await postStatus(webviewView.webview, "error", detail);
      }
    });
  }
}

function isRunRequest(message: unknown): message is RunRequestMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<RunRequestMessage>;
  return (
    candidate.type === "run" &&
    typeof candidate.request === "string" &&
    isAgentId(candidate.agentId)
  );
}

function isAgentId(value: unknown): value is AgentId {
  return (
    value === "claude" ||
    value === "codex" ||
    value === "gemini" ||
    value === "custom"
  );
}

async function postStatus(
  webview: vscode.Webview,
  state: "running" | "success" | "error",
  message: string
): Promise<void> {
  await webview.postMessage({ type: "status", state, message });
}

function getHtml(webview: vscode.Webview): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>TraceOS Memory</title>
  <style nonce="${nonce}">
    body {
      padding: 16px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
    }
    label {
      display: block;
      margin: 0 0 6px;
      font-weight: 600;
    }
    textarea, select {
      box-sizing: border-box;
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 2px;
      font: inherit;
    }
    textarea {
      min-height: 150px;
      padding: 8px;
      resize: vertical;
    }
    select {
      height: 32px;
      padding: 0 8px;
    }
    .field {
      margin-bottom: 14px;
    }
    button {
      width: 100%;
      padding: 8px 12px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 0;
      border-radius: 2px;
      font-weight: 600;
      cursor: pointer;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:disabled {
      cursor: wait;
      opacity: 0.65;
    }
    #status {
      min-height: 36px;
      margin-top: 12px;
      color: var(--vscode-descriptionForeground);
      line-height: 1.4;
    }
    #status.error {
      color: var(--vscode-errorForeground);
    }
  </style>
</head>
<body>
  <div class="field">
    <label for="request">User request</label>
    <textarea id="request" placeholder="Describe the engineering task..."></textarea>
  </div>
  <div class="field">
    <label for="agent">Coding agent</label>
    <select id="agent">
      <option value="claude">Claude Code</option>
      <option value="codex">Codex</option>
      <option value="gemini">Gemini CLI</option>
      <option value="custom">Custom command</option>
    </select>
  </div>
  <button id="run">Run With TraceOS Memory</button>
  <div id="status" role="status" aria-live="polite"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const request = document.getElementById("request");
    const agent = document.getElementById("agent");
    const run = document.getElementById("run");
    const status = document.getElementById("status");

    run.addEventListener("click", () => {
      run.disabled = true;
      status.className = "";
      status.textContent = "Starting...";
      vscode.postMessage({
        type: "run",
        request: request.value,
        agentId: agent.value
      });
    });

    window.addEventListener("message", (event) => {
      const message = event.data;
      if (message.type !== "status") {
        return;
      }

      status.textContent = message.message;
      status.className = message.state === "error" ? "error" : "";
      run.disabled = message.state === "running";
    });
  </script>
</body>
</html>`;
}

function createNonce(): string {
  const characters =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 32; index += 1) {
    value += characters.charAt(Math.floor(Math.random() * characters.length));
  }
  return value;
}
