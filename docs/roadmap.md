# Roadmap

What's built, what's next, and what's on the horizon.

Last updated: 2026-11-03

The issue-by-issue plan, in order, lives in the [wave roadmap](plans/2026-11-03-roadmap-waves.md).

## Shipped

These are live in the kit today.

| Feature | Status | Spec |
|---------|--------|------|
| Stdio transport (Fleet over MCP) | Done | [stdio-transport-spec](specs/stdio-transport-spec.md) |
| MCP tool server (`/mcp` endpoint) | Done | [mcp-interface](mcp-interface.md) |
| Host layer + config system | Done | [phase1-host-layer-spec](specs/phase1-host-layer-spec.md) |
| Run loop + strategies (ReAct, Plan-Execute) | Done | [phase2-run-loop-spec](specs/phase2-run-loop-spec.md) |
| Budgets (iteration, cost, token, time caps) | Done | [run-loop](run-loop.md) |
| Guardrails (per-tool policies, sandbox, dry-run) | Done | [run-loop](run-loop.md) |
| Tiered worker dispatch (pool + ephemeral + queue) | Done | [tiered-worker-dispatch-spec](specs/tiered-worker-dispatch-spec.md) |
| Async jobs API (SQLite queue, SSE, webhooks) | Done | [phase4-jobs-durable-spec](specs/phase4-jobs-durable-spec.md) |
| Azure Durable Functions backend | Done | [deploy-azure](deploy-azure-functions.md) |
| Chat UI | Done | [chat-ui-spec](specs/chat-ui-spec.md) |
| 12 Python tools (weather, geocode, currency, forecast, etc.) | Done | — |
| Communication adapters (Express, raw-http, Azure Functions) | Done | — |
| Travel agent output quality (prompts + 2 new tools) | Done | [travel-agent-quality-spec](specs/travel-agent-quality-spec.md) |
| Strategy auto-router | Done | [strategy-router-spec](specs/strategy-router-spec.md) |
| `npm create` scaffolding CLI | Done | [create-command-spec](specs/create-command-spec.md) |
| Agent-builder skill (`/agent-builder`) | Done | [agent-builder-spec](specs/agent-builder-skill-spec.md) |
| Trace IDs (end-to-end correlation) | Done | [CONTRACT](CONTRACT.md) |
| Kill switch (disable all writes without redeploy) | Done | [CONTRACT](CONTRACT.md) |
| Concurrency acceptance tests | Done | [concurrency](concurrency.md) |
| Scheduled workflows | Done | [scheduled-workflows-spec](specs/scheduled-workflows-spec.md) |
| Docker VM + Azure Functions deployment modes | Done | [getting-started](getting-started.md) |
| Fleet auth provisioning in Docker | Done | [deploy-azure](deploy-azure-functions.md) |
| `npm create` published to npm | Done | Published as `@apralabs/create-agent-kit`. Install via `npm create @apralabs/agent-kit`. |
| Memory: conversation context, run state, long-term facts (decay, dedup) | Done | [memory](memory.md) |
| Eval harness (runner, 7 graders, suites, `npm run eval`) | Done | [eval-harness-spec](specs/eval-harness-spec.md) |
| Durable human input (approvals and questions that pause and resume a run) | Done | [human-input](human-input.md) |
| Checkpoints and resume after a crash or a pause | Done | [memory-human-input-integration-spec](specs/2026-09-29-memory-human-input-integration-spec.md) |
| Dynamic `ask-user` tool, wired through workflows | Done | [human-input](human-input.md) |
| Azure durable-entity storage, with Cosmos and MSSQL store options | Done | [azure-durable-entity-storage-spec](specs/2026-09-30-azure-durable-entity-storage-spec.md) |
| Retention and expiry of job and question records | Done | [human-input](human-input.md#storage-and-retention) |
| One-command smoke test (`npm run smoke`, `npm run smoke:live`) | Done | `scripts/smoke-test.mjs` |

## Next Up

Wave 0 and wave 1 of the [wave roadmap](plans/2026-11-03-roadmap-waves.md):

| Wave | Focus | Issues |
|------|-------|--------|
| 0 | Trustworthy testing: fix the masked e2e job, add `npm run verify` | [#89](https://github.com/Apra-Labs/apra-agent-kit/issues/89) |
| 1 | Safe to deploy: secrets, prompt injection, approvals, audit | [#74](https://github.com/Apra-Labs/apra-agent-kit/issues/74), [#72](https://github.com/Apra-Labs/apra-agent-kit/issues/72), [#73](https://github.com/Apra-Labs/apra-agent-kit/issues/73), [#45](https://github.com/Apra-Labs/apra-agent-kit/issues/45), [#26](https://github.com/Apra-Labs/apra-agent-kit/issues/26), [#25](https://github.com/Apra-Labs/apra-agent-kit/issues/25) |

Still open from the old Phase 3 plan: compaction of the working context inside a single run ([#86](https://github.com/Apra-Labs/apra-agent-kit/issues/86)), and running evals on every prompt or model change.

## Planned

Features identified from the vision and codebase gaps. Not yet specced; each links to its issue.

### Connectors (LLM Providers)

Tracked in [#81](https://github.com/Apra-Labs/apra-agent-kit/issues/81).

The kit currently provisions Claude Code instances via Fleet. To support more providers:

| Connector | What it does | Priority |
|-----------|-------------|----------|
| **OpenAI** | Register members backed by GPT-4o / o3. Route cheaper reasoning steps to OpenAI, keep complex planning on Claude. | High |
| **Azure OpenAI** | Same as OpenAI but through Azure endpoints — needed for enterprise deployments with data residency. | High |
| **Gemini** | Google's models as an alternative provider. Register members backed by Gemini. | Medium |
| **Ollama / Local models** | Self-hosted models for air-gapped environments or cost-sensitive workloads. | Medium |
| **Cursor** | The PPT notes Fleet can register Cursor as a member type. | Low |

This requires abstracting the LLM interface so `fleetApi.executePrompt()` routes to the right provider based on the member's type. The dispatcher already manages doer/reviewer pairs — each pair could use a different provider.

Cost optimization: route simpler reasoning steps to cheaper models (e.g. GPT-4o-mini for argument resolution) and reserve expensive models (Claude Opus) for complex planning.

### Communication layer improvements

Four doors, one room — none of them should live inside the agent:

| Door | Status | What's needed |
|------|--------|---------------|
| Chat input (person types) | Done | Chat UI ships today |
| Queue (another service sends) | Partial | Job queue exists; needs Redis Streams consumer group for production dispatch |
| Schedule (cron fires) | Done | Config-driven cron in `host.config.mjs`. Each tick submits a named workflow through the jobs API (`queue` or `skip` overlap). In-process croner timers or Azure Timer Triggers; backend follows `JOBS_BACKEND`. See [scheduled-workflows](scheduled-workflows.md). |
| MCP (another agent calls) | Done | `/mcp` endpoint ships today, including `submit-task`, `job-status` and `job-input` |
| Slack and Teams (a person in a chat app) | Planned | [#82](https://github.com/Apra-Labs/apra-agent-kit/issues/82) |
| OpenAI-compatible API (existing OpenAI clients) | Planned | [#83](https://github.com/Apra-Labs/apra-agent-kit/issues/83) |

### Authentication

Authentication is the adopter's choice: inject an authenticator with `startHost({ authenticate })` (`mcp/auth.mjs` is the anonymous default, and `getting-started.md` shows how). Still needed:

- A startup warning when approvals run with the anonymous default ([#74](https://github.com/Apra-Labs/apra-agent-kit/issues/74))
- Policies per user and role ([#22](https://github.com/Apra-Labs/apra-agent-kit/issues/22)) and rate limiting per tool ([#24](https://github.com/Apra-Labs/apra-agent-kit/issues/24))

### Task triage

A triage layer at the chat/input boundary should classify: question vs task vs too vague:
- "What is our leave policy?" → one model call, no agent needed
- "Find the mismatched invoices" → many steps, several tools, agent needed

The strategy auto-router classifies between workflows, open-ended, and plan-execute — but doesn't yet distinguish "no agent needed" questions from agent-worthy tasks. Tracked in [#79](https://github.com/Apra-Labs/apra-agent-kit/issues/79).

### Observability

Trace IDs are shipped (end-to-end correlation from request through run loop). Still needed:

- Structured logging for run loop iterations
- Cost tracking dashboard (per-run budgets exist; trend/alert across runs does not)
- Latency breakdowns per tool call
- Error rate monitoring

Tracked in [#84](https://github.com/Apra-Labs/apra-agent-kit/issues/84).

### Safety and provenance

Kill switch is shipped (disable all writes across a deployment without a redeploy), and `docs/CONTRACT.md` tells adopters to decide on provenance before their first write. Still needed:

- Hide secrets wherever tool data is saved or logged ([#72](https://github.com/Apra-Labs/apra-agent-kit/issues/72))
- Scan tool results and memory writes for prompt injection ([#73](https://github.com/Apra-Labs/apra-agent-kit/issues/73))
- A per-run cap on irreversible calls, and recording who approved ([#45](https://github.com/Apra-Labs/apra-agent-kit/issues/45))

## Future / Exploration

These are longer-term ideas, not committed.

| Idea | Notes |
|------|-------|
| Redis Streams dispatch | Production-grade consumer groups; workers claim messages, ack on completion, unacked work reclaimed on death |
| Agent-to-agent communication | Already possible over MCP (`submit-task`); a helper-agent `delegate` tool is [#88](https://github.com/Apra-Labs/apra-agent-kit/issues/88) |
| Horizontal scaling patterns | Documentation and examples for multi-container deployments |
| Plugin system | Third-party tool packages that register into the MCP catalog; sharing skills is [#87](https://github.com/Apra-Labs/apra-agent-kit/issues/87) |
| Skills | Plain-English know-how the agent loads on demand ([#76](https://github.com/Apra-Labs/apra-agent-kit/issues/76), [#77](https://github.com/Apra-Labs/apra-agent-kit/issues/77)) |
| API-only agents (no Fleet) | For tasks that are pure API calls with no filesystem — Fleet binding is vestigial for these |
