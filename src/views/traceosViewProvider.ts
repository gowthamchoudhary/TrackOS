import * as vscode from "vscode";
import { AgentId } from "../services/agentRunner";

interface RunRequestMessage {
  type: "run";
  request: string;
  agentId: AgentId;
}

interface CommandMessage {
  type: "command";
  command: "viewAgentOutput" | "openSessionLog";
}

interface SetTeamCodeMessage {
  type: "setTeamCode";
  teamCode: string;
}

interface CopyToClipboardMessage {
  type: "copyToClipboard";
  text: string;
}

export type TraceosPhase =
  | "ready"
  | "capturing"
  | "syncing"
  | "context"
  | "launching"
  | "running"
  | "error";

export interface TraceosSidebarState {
  phase: TraceosPhase;
  backendConnected: boolean;
  memoriesStored: number;
  lastSync: string;
  selectedAgent: AgentId;
  latestEvent: string;
  latestError?: string;
}

export type TraceosStatusUpdate = Partial<TraceosSidebarState>;

export type TraceosRunHandler = (
  request: string,
  agentId: AgentId,
  reportStatus: (update: TraceosStatusUpdate) => Promise<void>
) => Promise<string>;

const INITIAL_STATE: TraceosSidebarState = {
  phase: "capturing",
  backendConnected: false,
  memoriesStored: 0,
  lastSync: "",
  selectedAgent: "claude",
  latestEvent: "TraceOS is recording workspace evidence automatically."
};

export class TraceosViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "traceos.sidebar";
  private webview: vscode.Webview | undefined;
  private state: TraceosSidebarState = { ...INITIAL_STATE };
  private runActive = false;

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
    void postState(webviewView.webview, this.state);
    void postTeamCode(webviewView.webview);
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        void postTeamCode(webviewView.webview);
      }
    });

    webviewView.webview.onDidReceiveMessage(async (message: unknown) => {
      if (isCommandMessage(message)) {
        await vscode.commands.executeCommand(`traceos.${message.command}`);
        return;
      }

      if (isSetTeamCodeMessage(message)) {
        await vscode.workspace
          .getConfiguration("traceos")
          .update(
            "teamId",
            message.teamCode,
            vscode.ConfigurationTarget.Global
          );
        const workspaceName = vscode.workspace.name ??
          vscode.workspace.workspaceFolders?.[0]?.name ??
          "Unknown Project";
        await webviewView.webview.postMessage({
          type: "restoreTeamCode",
          teamCode: message.teamCode,
          projectName: workspaceName
        });
        return;
      }

      if (isCopyToClipboardMessage(message)) {
        await vscode.env.clipboard.writeText(message.text);
        return;
      }

      if (!isRunRequest(message)) {
        return;
      }

      const request = message.request.trim();
      if (!request) {
        await this.updateState({
          phase: "error",
          selectedAgent: message.agentId,
          latestError: "Enter a request first.",
          latestEvent: "Request was not started."
        });
        return;
      }

      await this.updateState({
        phase: "capturing",
        selectedAgent: message.agentId,
        latestEvent: "Capturing current workspace evidence.",
        latestError: undefined
      });
      this.runActive = true;

      try {
        const latestEvent = await this.runHandler(
          request,
          message.agentId,
          (update) => this.updateState(update)
        );
        this.runActive = false;
        await this.updateState({
          ...(this.state.phase === "error" ? {} : { phase: "ready" }),
          latestEvent
        });
      } catch (error) {
        this.runActive = false;
        const detail = error instanceof Error ? error.message : String(error);
        await this.updateState({
          phase: "error",
          latestEvent: "TraceOS stopped the current run.",
          latestError: detail
        });
      }
    });
  }

  public async reportStatus(update: TraceosStatusUpdate): Promise<void> {
    if (this.runActive) {
      const {
        backendConnected,
        memoriesStored,
        lastSync,
        latestError
      } = update;
      await this.updateState({
        ...(backendConnected === undefined ? {} : { backendConnected }),
        ...(memoriesStored === undefined ? {} : { memoriesStored }),
        ...(lastSync === undefined ? {} : { lastSync }),
        ...(latestError === undefined ? {} : { latestError })
      });
      return;
    }
    await this.updateState(update);
  }

  private async updateState(update: TraceosStatusUpdate): Promise<void> {
    this.state = {
      ...this.state,
      ...update
    };
    if (this.webview) {
      await postState(this.webview, this.state);
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

function isCommandMessage(message: unknown): message is CommandMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<CommandMessage>;
  return (
    candidate.type === "command" &&
    (candidate.command === "viewAgentOutput" ||
      candidate.command === "openSessionLog")
  );
}

function isSetTeamCodeMessage(
  message: unknown
): message is SetTeamCodeMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<SetTeamCodeMessage>;
  return (
    candidate.type === "setTeamCode" &&
    typeof candidate.teamCode === "string"
  );
}

function isCopyToClipboardMessage(
  message: unknown
): message is CopyToClipboardMessage {
  if (!message || typeof message !== "object") {
    return false;
  }

  const candidate = message as Partial<CopyToClipboardMessage>;
  return (
    candidate.type === "copyToClipboard" &&
    typeof candidate.text === "string"
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

async function postState(
  webview: vscode.Webview,
  state: TraceosSidebarState
): Promise<void> {
  await webview.postMessage({ type: "state", state });
}

async function postTeamCode(webview: vscode.Webview): Promise<void> {
  const currentTeamId = vscode.workspace
    .getConfiguration("traceos")
    .get<string>("teamId", "");
  const workspaceName = vscode.workspace.name ??
    vscode.workspace.workspaceFolders?.[0]?.name ??
    "Unknown Project";
  await webview.postMessage({
    type: "restoreTeamCode",
    teamCode: currentTeamId,
    projectName: workspaceName
  });
}

function getHtml(webview: vscode.Webview): string {
  const nonce = createNonce();

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <title>TraceOS</title>
  <style nonce="${nonce}">
    :root {
      color-scheme: light dark;
    }
    * {
      box-sizing: border-box;
    }
    body {
      margin: 0;
      padding: 18px 14px 24px;
      color: var(--vscode-foreground);
      background: var(--vscode-sideBar-background);
      font-family: var(--vscode-font-family);
      font-size: var(--vscode-font-size);
    }
    .shell {
      display: grid;
      gap: 14px;
      max-width: 520px;
      margin: 0 auto;
    }
    .header {
      display: flex;
      align-items: flex-start;
      justify-content: space-between;
      gap: 12px;
      padding: 2px 2px 0;
    }
    .brand h1 {
      margin: 0;
      font-size: 22px;
      line-height: 1.15;
      letter-spacing: -0.02em;
    }
    .subtitle {
      margin: 5px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 12px;
      line-height: 1.4;
    }
    .pill {
      flex: 0 0 auto;
      min-width: 68px;
      padding: 5px 9px;
      color: var(--vscode-foreground);
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
      border-radius: 999px;
      font-size: 11px;
      font-weight: 600;
      text-align: center;
      white-space: nowrap;
    }
    .pill[data-phase="capturing"],
    .pill[data-phase="syncing"],
    .pill[data-phase="context"],
    .pill[data-phase="launching"],
    .pill[data-phase="running"] {
      border-color: var(--vscode-focusBorder);
    }
    .pill[data-phase="error"] {
      color: var(--vscode-errorForeground);
      border-color: var(--vscode-errorForeground);
    }
    .card {
      overflow: hidden;
      background: var(--vscode-editor-background);
      border: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
      border-radius: 10px;
      box-shadow: 0 1px 2px var(--vscode-widget-shadow, transparent);
    }
    .card-body {
      padding: 14px;
    }
    .section-label {
      margin: 0 0 10px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .stats {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .stat {
      min-height: 62px;
      padding: 12px 14px;
      border-right: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
      border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
    }
    .stat:nth-child(2n) {
      border-right: 0;
    }
    .stat:nth-last-child(-n + 2) {
      border-bottom: 0;
    }
    .stat-label {
      display: block;
      margin-bottom: 6px;
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.05em;
    }
    .stat-value {
      display: block;
      overflow: hidden;
      font-size: 13px;
      font-weight: 600;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    label {
      display: block;
      margin: 0 0 7px;
      font-size: 12px;
      font-weight: 600;
    }
    textarea,
    select {
      width: 100%;
      color: var(--vscode-input-foreground);
      background: var(--vscode-input-background);
      border: 1px solid var(--vscode-input-border, transparent);
      border-radius: 7px;
      font: inherit;
      outline: none;
      transition: border-color 120ms ease, box-shadow 120ms ease;
    }
    textarea:focus,
    select:focus {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    textarea {
      min-height: 152px;
      padding: 12px;
      line-height: 1.5;
      resize: vertical;
    }
    select {
      height: 38px;
      padding: 0 10px;
    }
    .field + .field {
      margin-top: 14px;
    }
    .button-stack {
      display: grid;
      gap: 8px;
    }
    .helper {
      margin: 7px 0 0;
      color: var(--vscode-descriptionForeground);
      font-size: 11px;
      line-height: 1.45;
    }
    .microcopy {
      display: grid;
      gap: 5px;
      margin-top: 12px;
      padding-top: 12px;
      color: var(--vscode-descriptionForeground);
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
      font-size: 11px;
      line-height: 1.4;
    }
    button {
      width: 100%;
      min-height: 42px;
      padding: 9px 14px;
      color: var(--vscode-button-foreground);
      background: var(--vscode-button-background);
      border: 1px solid transparent;
      border-radius: 7px;
      font: inherit;
      font-weight: 700;
      cursor: pointer;
      outline: none;
      transition: background 120ms ease, opacity 120ms ease;
    }
    button:hover {
      background: var(--vscode-button-hoverBackground);
    }
    button:focus-visible {
      border-color: var(--vscode-focusBorder);
      box-shadow: 0 0 0 1px var(--vscode-focusBorder);
    }
    button:disabled {
      cursor: progress;
      opacity: 0.68;
    }
    .secondary-button {
      color: var(--vscode-button-secondaryForeground);
      background: var(--vscode-button-secondaryBackground);
      border-color: var(--vscode-widget-border, transparent);
    }
    .secondary-button:hover {
      background: var(--vscode-button-secondaryHoverBackground);
    }
    .status-grid {
      display: grid;
      gap: 11px;
    }
    .status-row {
      display: grid;
      gap: 3px;
    }
    .status-key {
      color: var(--vscode-descriptionForeground);
      font-size: 10px;
      font-weight: 700;
      letter-spacing: 0.05em;
      text-transform: uppercase;
    }
    .status-value {
      line-height: 1.45;
      overflow-wrap: anywhere;
    }
    .error-row {
      display: none;
      padding-top: 10px;
      color: var(--vscode-errorForeground);
      border-top: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
    }
    .error-row.visible {
      display: grid;
    }
    .section { margin-bottom: 16px; padding: 12px; border: 1px solid var(--vscode-widget-border); border-radius: 4px; }
    .section-label { font-size: 10px; font-weight: 600; letter-spacing: 0.08em; color: var(--vscode-descriptionForeground); margin-bottom: 10px; }
    .team-mode-display { display: flex; flex-direction: column; gap: 8px; }
    .team-status-row { display: flex; align-items: center; gap: 6px; }
    .team-status-dot { width: 8px; height: 8px; border-radius: 50%; }
    .team-status-dot.solo { background: var(--vscode-descriptionForeground); }
    .team-status-dot.team { background: #4caf50; }
    .team-status-text { font-size: 12px; font-weight: 500; }
    .team-actions { display: flex; flex-direction: column; gap: 6px; }
    .team-join-row { display: flex; gap: 6px; }
    .team-join-row input { flex: 1; padding: 4px 8px; font-size: 11px; background: var(--vscode-input-background); color: var(--vscode-input-foreground); border: 1px solid var(--vscode-input-border); border-radius: 3px; }
    .team-code-display { display: flex; align-items: center; gap: 6px; font-size: 11px; }
    .team-project-row { display: flex; align-items: center; gap: 6px; font-size: 11px; margin-top: 2px; }
    .team-code-label { color: var(--vscode-descriptionForeground); }
    .team-code-value { font-family: monospace; font-size: 10px; color: var(--vscode-textLink-foreground); word-break: break-all; }
    .btn-secondary { padding: 4px 10px; font-size: 11px; cursor: pointer; background: var(--vscode-button-secondaryBackground); color: var(--vscode-button-secondaryForeground); border: none; border-radius: 3px; }
    .btn-secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
    .btn-leave { margin-top: 2px; }
    .btn-icon { background: none; border: none; cursor: pointer; color: var(--vscode-textLink-foreground); font-size: 14px; padding: 0 4px; }
    @media (max-width: 260px) {
      .header {
        display: grid;
      }
      .pill {
        justify-self: start;
      }
      .stats {
        grid-template-columns: 1fr;
      }
      .stat,
      .stat:nth-child(2n),
      .stat:nth-last-child(-n + 2) {
        border-right: 0;
        border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-input-border));
      }
      .stat:last-child {
        border-bottom: 0;
      }
    }
  </style>
</head>
<body>
  <main class="shell">
    <header class="header">
      <div class="brand">
        <h1>TraceOS</h1>
        <p class="subtitle">Autonomous memory for coding agents</p>
      </div>
      <div id="phasePill" class="pill" data-phase="capturing">Capturing</div>
    </header>

    <section class="card" aria-label="Memory status">
      <div class="stats">
        <div class="stat">
          <span class="stat-label">Memories stored</span>
          <span id="memoriesStored" class="stat-value">0</span>
        </div>
        <div class="stat">
          <span class="stat-label">Last sync</span>
          <span id="lastSync" class="stat-value">Not yet</span>
        </div>
        <div class="stat">
          <span class="stat-label">Backend</span>
          <span id="backend" class="stat-value">Connecting</span>
        </div>
        <div class="stat">
          <span class="stat-label">Agent</span>
          <span id="selectedAgent" class="stat-value">Claude Code</span>
        </div>
      </div>
    </section>

    <section class="card">
      <div class="card-body">
        <p class="section-label">Request composer</p>
        <div class="field">
          <label for="request">What should your agent do?</label>
          <textarea id="request" placeholder="Ask your coding agent with TraceOS memory…"></textarea>
          <p class="helper">Ctrl+Enter runs. Enter adds a new line.</p>
        </div>
        <div class="field">
          <label for="agent">Coding agent</label>
          <select id="agent">
            <option value="claude">Claude Code</option>
            <option value="codex">Codex</option>
            <option value="gemini">Gemini CLI</option>
            <option value="custom">Custom</option>
          </select>
          <p class="helper">TraceOS attaches context automatically. Missing CLIs fall back to prompt file.</p>
        </div>
        <div class="microcopy">
          <span>TraceOS is recording workspace evidence automatically.</span>
          <span>Context uses diagnostics, git changes, terminal logs, and agent output.</span>
          <span>Your request is sent with TRACEOS_CONTEXT.md attached.</span>
        </div>
      </div>
    </section>

    <div class="button-stack">
      <button id="run" type="button">Run With Memory</button>
      <button id="viewOutput" class="secondary-button" type="button">View Agent Output</button>
      <button id="openLog" class="secondary-button" type="button">Open Session Log</button>
    </div>

    <div class="section" id="team-section">
      <div class="section-label">TEAM MEMORY</div>
      
      <div id="solo-mode" class="team-mode-display">
        <div class="team-status-row">
          <span class="team-status-dot solo"></span>
          <span class="team-status-text">Solo Mode</span>
        </div>
        <div class="team-actions">
          <button class="btn-secondary" id="generate-team-btn">Generate Team Code</button>
          <div class="team-join-row">
            <input type="text" id="team-code-input" placeholder="Enter team code..." maxlength="36" />
            <button class="btn-secondary" id="join-team-btn">Join</button>
          </div>
        </div>
      </div>

      <div id="team-mode" class="team-mode-display" style="display:none">
        <div class="team-status-row">
          <span class="team-status-dot team"></span>
          <span class="team-status-text" id="team-mode-label">Team Mode</span>
        </div>
        <div class="team-code-display">
          <span class="team-code-label">Team Code:</span>
          <span id="current-team-code" class="team-code-value">&mdash;</span>
          <button class="btn-icon" id="copy-team-code-btn" title="Copy team code">&#x29C9;</button>
        </div>
        <div class="team-project-row">
          <span class="team-code-label">Project:</span>
          <span id="team-project-name" class="team-code-value">—</span>
        </div>
        <button class="btn-secondary btn-leave" id="leave-team-btn">Leave Team</button>
      </div>
    </div>

    <section class="card" aria-live="polite" aria-atomic="true">
      <div class="card-body status-grid">
        <p class="section-label">Run status</p>
        <div class="status-row">
          <span class="status-key">Current status</span>
          <span id="currentStatus" class="status-value">Capturing</span>
        </div>
        <div class="status-row">
          <span class="status-key">Last memory sync</span>
          <span id="memorySync" class="status-value">No memories synced yet.</span>
        </div>
        <div class="status-row">
          <span class="status-key">Latest event</span>
          <span id="latestEvent" class="status-value">TraceOS is recording workspace evidence automatically.</span>
        </div>
        <div id="errorRow" class="status-row error-row">
          <span class="status-key">Latest error</span>
          <span id="latestError" class="status-value"></span>
        </div>
      </div>
    </section>
  </main>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const elements = {
      request: document.getElementById("request"),
      agent: document.getElementById("agent"),
      run: document.getElementById("run"),
      viewOutput: document.getElementById("viewOutput"),
      openLog: document.getElementById("openLog"),
      phasePill: document.getElementById("phasePill"),
      memoriesStored: document.getElementById("memoriesStored"),
      lastSync: document.getElementById("lastSync"),
      backend: document.getElementById("backend"),
      selectedAgent: document.getElementById("selectedAgent"),
      currentStatus: document.getElementById("currentStatus"),
      memorySync: document.getElementById("memorySync"),
      latestEvent: document.getElementById("latestEvent"),
      errorRow: document.getElementById("errorRow"),
      latestError: document.getElementById("latestError")
    };
    const phaseLabels = {
      ready: "Ready",
      capturing: "Capturing",
      syncing: "Syncing",
      context: "Building Context",
      launching: "Launching Agent",
      running: "Agent Running",
      error: "Error"
    };
    const buttonLabels = {
      ready: "Run With Memory",
      capturing: "Capturing…",
      syncing: "Syncing Memory…",
      context: "Building Context…",
      launching: "Launching Agent…",
      running: "Agent Running…",
      error: "Run With Memory"
    };
    const agentLabels = {
      claude: "Claude Code",
      codex: "Codex",
      gemini: "Gemini CLI",
      custom: "Custom"
    };
    let currentState;

    function submitRequest() {
      if (elements.run.disabled) {
        return;
      }
      vscode.postMessage({
        type: "run",
        request: elements.request.value,
        agentId: elements.agent.value
      });
    }

    function relativeTime(value) {
      if (!value) {
        return "Not yet";
      }
      const timestamp = Date.parse(value);
      if (Number.isNaN(timestamp)) {
        return value;
      }
      const elapsed = Math.max(0, Date.now() - timestamp);
      if (elapsed < 60_000) {
        return "just now";
      }
      if (elapsed < 3_600_000) {
        return Math.floor(elapsed / 60_000) + "m ago";
      }
      return new Date(timestamp).toLocaleTimeString([], {
        hour: "2-digit",
        minute: "2-digit"
      });
    }

    function render(state) {
      currentState = state;
      const phaseLabel = phaseLabels[state.phase] || "Ready";
      const busy = !["ready", "error"].includes(state.phase);
      const pillLabel =
        !state.backendConnected && state.latestError
          ? "Backend offline"
          : phaseLabel;

      elements.phasePill.textContent = pillLabel;
      elements.phasePill.dataset.phase = state.phase;
      elements.memoriesStored.textContent = String(state.memoriesStored);
      elements.lastSync.textContent = relativeTime(state.lastSync);
      elements.backend.textContent = state.backendConnected
        ? "Connected"
        : "Local only";
      elements.selectedAgent.textContent =
        agentLabels[state.selectedAgent] || "Custom";
      elements.agent.value = state.selectedAgent;
      elements.currentStatus.textContent = phaseLabel;
      elements.memorySync.textContent =
        state.lastSync
          ? state.memoriesStored + " " +
            (state.memoriesStored === 1 ? "memory" : "memories") +
            " stored " + relativeTime(state.lastSync) + "."
          : "No memories synced yet.";
      elements.latestEvent.textContent =
        state.latestEvent || "TraceOS is ready.";
      elements.latestError.textContent = state.latestError || "";
      elements.errorRow.classList.toggle("visible", Boolean(state.latestError));
      elements.run.disabled = busy;
      elements.run.textContent = buttonLabels[state.phase] || "Run With Memory";
    }

    elements.run.addEventListener("click", submitRequest);
    elements.viewOutput.addEventListener("click", () => {
      vscode.postMessage({ type: "command", command: "viewAgentOutput" });
    });
    elements.openLog.addEventListener("click", () => {
      vscode.postMessage({ type: "command", command: "openSessionLog" });
    });
    elements.request.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && event.ctrlKey) {
        event.preventDefault();
        submitRequest();
      }
    });
    elements.agent.addEventListener("change", () => {
      if (!currentState) {
        return;
      }
      currentState = {
        ...currentState,
        selectedAgent: elements.agent.value
      };
      elements.selectedAgent.textContent =
        agentLabels[elements.agent.value] || "Custom";
    });

    // Team mode state
    let currentTeamCode = "";

    function generateUUID() {
      // Generate a UUID v4 (128-bit random, RFC 4122)
      return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function(c) {
        const r = Math.random() * 16 | 0;
        const v = c === "x" ? r : (r & 0x3 | 0x8);
        return v.toString(16);
      });
    }

    function showTeamMode(code) {
      currentTeamCode = code;
      document.getElementById("solo-mode").style.display = "none";
      document.getElementById("team-mode").style.display = "flex";
      document.getElementById("current-team-code").textContent = code;
      document.getElementById("team-mode-label").textContent = "Team Mode Active";
      const workspaceName = document.title ||
        window.location.pathname.split('/').pop() ||
        'current project';
      document.getElementById('team-project-name').textContent = workspaceName;
    }

    function showSoloMode() {
      currentTeamCode = "";
      document.getElementById("solo-mode").style.display = "flex";
      document.getElementById("team-mode").style.display = "none";
      document.getElementById("team-code-input").value = "";
    }

    document.getElementById("generate-team-btn").addEventListener("click", () => {
      const code = generateUUID();
      vscode.postMessage({ type: "setTeamCode", teamCode: code });
      showTeamMode(code);
    });

    document.getElementById("join-team-btn").addEventListener("click", () => {
      const code = document.getElementById("team-code-input").value.trim();
      if (!code) return;
      vscode.postMessage({ type: "setTeamCode", teamCode: code });
      showTeamMode(code);
    });

    document.getElementById("leave-team-btn").addEventListener("click", () => {
      vscode.postMessage({ type: "setTeamCode", teamCode: "" });
      showSoloMode();
    });

    document.getElementById("copy-team-code-btn").addEventListener("click", () => {
      if (currentTeamCode) {
        navigator.clipboard.writeText(currentTeamCode).catch(() => {
          vscode.postMessage({ type: "copyToClipboard", text: currentTeamCode });
        });
      }
    });

    window.addEventListener("message", (event) => {
      if (event.data.type === "state") {
        render(event.data.state);
      }
      if (event.data.type === "restoreTeamCode") {
        if (event.data.teamCode) {
          showTeamMode(event.data.teamCode);
          const el = document.getElementById('team-project-name');
          if (el) el.textContent = event.data.projectName || 'Unknown Project';
        } else {
          showSoloMode();
        }
      }
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
