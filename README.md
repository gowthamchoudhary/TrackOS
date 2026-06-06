# TraceOS

TraceOS is an engineering memory layer for coding agents. The VS Code
extension captures exact diagnostics, git diffs, terminal evidence, and
workspace context locally, then sends snapshots to a managed backend.

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

- `traceos.backendUrl` defaults to `http://localhost:8000`
- `traceos.userId` defaults to `local_user`
- `traceos.autoStartCapture`
- `traceos.customAgentCommand`
- `traceos.autoSubmitPrompt`

When the backend cannot be reached, TraceOS continues with current and locally
saved evidence, writes `.traceos/TRACEOS_CONTEXT.md`, and reports:

```text
TraceOS backend unavailable. Running local context only.
```
