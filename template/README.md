# {{PROJECT_NAME}}

An agent built on [Apra Fleet](https://github.com/Apra-Labs/apra-fleet) with the
[workflow kit](https://github.com/Apra-Labs/apra-agent-kit).

## Quickstart

### 1. Verify your environment

```bash
npm run doctor     # check prerequisites
npm test           # mock tests — no Fleet, no token needed
```

### 2. Run locally (no Docker)

```bash
# Linux / macOS
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
npm run hello      # run the starter workflow
npm run host       # start the full agent on :3000
```

```powershell
# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token)
npm run hello      # run the starter workflow
npm run host       # start the full agent on :3000
```

Open **http://localhost:3000/chat** — the chat UI.

### 3. Run with Docker — VM mode

```bash
# Linux / macOS
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose up --build
```

```powershell
# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token)
docker compose up --build
```

Open **http://localhost:3000/chat**.

### 4. Run with Docker — Azure Functions mode

```bash
# Linux / macOS
CLAUDE_CODE_OAUTH_TOKEN=$(claude setup-token) docker compose -f docker-compose.azure.yml up --build
```

```powershell
# Windows (PowerShell)
$env:CLAUDE_CODE_OAUTH_TOKEN = (claude setup-token)
docker compose -f docker-compose.azure.yml up --build
```

Open **http://localhost:7071/api/chat** (all endpoints are prefixed with `/api`).

### Stop any Docker mode

```bash
docker compose down                                  # VM
docker compose -f docker-compose.azure.yml down      # Azure Functions
```

---

## Endpoints

| Endpoint | VM mode | Azure Functions mode |
|---|---|---|
| Chat UI | `/chat` | `/api/chat` |
| Submit task | `POST /task` | `POST /api/task` |
| Job status | `GET /jobs/{id}` | `GET /api/jobs/{id}` |
| SSE events | `GET /jobs/{id}/events` | `GET /api/jobs/{id}/events` |
| Cancel job | `DELETE /jobs/{id}` | `DELETE /api/jobs/{id}` |
| MCP server | `POST /mcp` | `POST /api/mcp` |
| Health check | `GET /health` | `GET /api/health` |
| Schedules | `GET /schedules` | `GET /api/schedules` |

Register the MCP server with Claude Code:

```bash
claude mcp add --transport http {{PROJECT_NAME}} http://127.0.0.1:3000/mcp
```

---

## Write your first workflow

Copy `workflows/hello/` and rename it. The body (`hello.js`) does the work; the
launcher (`main.mjs`) spawns Fleet and leases a worker pair. Address the pair as
`'doer'` and `'reviewer'` — never by member name.

Then append one entry to `mcp/registry.mjs` and it becomes an MCP tool. No
changes to `server.mjs` or `http.mjs` are needed.

## Your code and the kit's

You own every file here. `mcp/`, `pool/`, `host/`, `transport/` and `comm/` came
from the kit — `.kit-version` records which version. Yours to change; nothing
updates them for you.

| Path | What |
|---|---|
| `host.config.mjs` | Agent identity, personality, and module config |
| `mcp/registry.mjs` | Your tool catalog |
| `workflows/` | Your workflow bodies and launchers |
| `tools/` | Python tool scripts (stdlib only, no keys) |
| `docs/` | Kit architecture and development reference |
| `scripts/doctor.mjs` | Environment check |

## Memory (optional)

The kit includes a three-tier memory system. Uncomment the `memory` block in
`host.config.mjs` to enable:

| Tier | What it does |
|------|-------------|
| **Conversation context** | Carries prior chat turns across tasks within a session |
| **Run state** | Crash recovery — resumes interrupted tasks |
| **Long-term memory** | Cross-session facts with FSRS-6 decay |

When long-term memory is enabled, the agent gains four tools: `remember`,
`recall`, `forget`, and `promote`. Coach the agent to use them via the
`agentDescription` field in `host.config.mjs`.

## Token

`agent()` calls need an OAuth token:

```bash
export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"
```

`npm test` does not need one. `npm run hello` and `npm run host` do.

Docker modes forward `CLAUDE_CODE_OAUTH_TOKEN` into the container automatically.

## Next steps

- [docs/getting-started.md](docs/getting-started.md) — full guide with config reference and tool patterns
- [docs/memory.md](docs/memory.md) — three-tier memory system
- [docs/scheduled-workflows.md](docs/scheduled-workflows.md) — cron scheduling
- [docs/deploy-azure-functions.md](docs/deploy-azure-functions.md) — production deployment to Azure
