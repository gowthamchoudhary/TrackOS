import * as vscode from "vscode";
import { AgentId } from "../services/agentRouter";

interface RunRequestMessage {
  type: "run";
  request: string;
  agentId: AgentId;
}

export type TraceosRunHandler = (
  request: string,
  agentId: AgentId,
  reportStatus: (
    status: TraceosRunStatus,
    state?: "running" | "success" | "error"
  ) => Promise<void>
) => Promise<string>;

export type TraceosRunStatus = string;

export class TraceosViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "traceos.sidebar";
  private webview: vscode.Webview | undefined;
  private latestStatus = "Capturing";
  private latestState: "running" | "success" | "error" = "running";

  public constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly runHandler: TraceosRunHandler
  ) {}

  public resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.webview = webviewView.webview;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [this.extensionUri]
    };
    webviewView.webview.html = getHtml(webviewView.webview);
    webviewView.onDidDispose(() => {
      this.webview = undefined;
    });
    void this.reportStatus(this.latestStatus, this.latestState);
    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (!isRunRequest(message)) {
        return;
      }

      const request = message.request.trim();
      if (!request) {
        await postStatus(
          webviewView.webview,
          "error",
          "Enter a request first.",
          false
        );
        return;
      }

      await postStatus(
        webviewView.webview,
        "running",
        "Capturing",
        true
      );

      try {
        const status = await this.runHandler(
          request,
          message.agentId,
          async (runStatus, state = "running") => {
            await postStatus(webviewView.webview, state, runStatus, true);
          }
        );
        await postStatus(webviewView.webview, "success", status, false);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        await postStatus(webviewView.webview, "error", detail, false);
      }
    });
  }

  public async reportStatus(
    message: string,
    state: "running" | "success" | "error" = "running"
  ): Promise<void> {
    this.latestStatus = message;
    this.latestState = state;
    if (this.webview) {
      await postStatus(this.webview, state, message);
    }
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
  message: string,
  busy = false
): Promise<void> {
  await webview.postMessage({ type: "status", state, message, busy });
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
    .agent-help {
      margin: -6px 0 14px;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.5;
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
    #status .error {
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
  <div class="agent-help">
    Terminal agents require installed CLIs: <code>claude</code>,
    <code>codex</code>, <code>gemini</code>. If unavailable, TraceOS copies
    the prepared prompt.
  </div>
  <button id="run">Run With TraceOS Memory</button>
  <div id="status" role="status" aria-live="polite">Capturing</div>

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

      const entry = document.createElement("div");
      entry.textContent = message.message;
      if (message.state === "error") {
        entry.className = "error";
      }
      status.appendChild(entry);
      while (status.children.length > 6) {
        status.removeChild(status.firstChild);
      }
      run.disabled = message.busy === true;
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
