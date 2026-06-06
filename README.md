# TraceOS

TraceOS is an engineering memory layer for coding agents. The VS Code
extension captures exact diagnostics, git diffs, terminal evidence, and
workspace context locally, then sends snapshots to a managed backend.

TraceOS activates and starts capture when VS Code opens. The normal workflow
is entirely in the TraceOS sidebar: enter a request, select a coding agent,
and choose **Run With TraceOS Memory**. TraceOS refreshes evidence, performs
managed ingestion and recall, writes `.traceos/TRACEOS_CONTEXT.md`, and starts
the selected agent with that context automatically.

## Architecture

```text
VS Code Extension -> TraceOS Backend -> HydraDB
```

The extension never reads or stores a HydraDB API key. The backend owns the
HydraDB client, tenant configuration, ingestion, and recall.

## Backend

Required environment:

```text
HYDRA_DB_API_KEY=
HYDRA_TENANT_ID=traceos
```

Optional environment:

```text
PORT=8000
TRACEOS_DATA_DIR=.traceos-backend
```

Start the backend from PowerShell:

```powershell
$env:HYDRA_DB_API_KEY = "your-backend-key"
$env:HYDRA_TENANT_ID = "traceos"
npm run backend
```

Routes:

- `GET /api/health`
- `POST /api/memory/ingest`
- `POST /api/context/assemble`

Raw diagnostics, git diffs, and terminal logs are ingested with `infer:false`.
Pattern memories use `infer:true` only after the backend observes the exact
same diagnostic in more than one distinct snapshot.

## Extension Settings

- `traceos.backendUrl` defaults to `https://trackos-h16r.onrender.com`
- `traceos.userId` defaults to `local_user`
- `traceos.customAgentCommand`
- `traceos.autoSubmitPrompt` defaults to `false` and applies to Custom command

TraceOS validates the selected CLI before opening an agent terminal. Claude
Code requires `claude`, Codex requires `codex`, and Gemini requires `gemini`.
For built-in agents, TraceOS writes the prepared prompt to
`.traceos/AGENT_PROMPT.md` and passes a short initial instruction as part of
the CLI launch command. This prevents prompt text from being interpreted by
the shell while the agent is still starting.
If a CLI is unavailable, TraceOS opens the generated context and copies the
agent prompt instead of sending prompt text to a shell.

The extension contains no HydraDB credentials. If managed ingestion or recall
fails, TraceOS still writes a local context from exact workspace evidence. It
then launches an installed agent CLI, or opens the context and copies the
prepared prompt when the selected CLI is unavailable.
