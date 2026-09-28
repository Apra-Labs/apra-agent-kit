# Fleet Agent Kit — Conversation Context

Status: approved design — not yet implemented.

## What this phase ships

Repurposes the dead-weight working-context tier into a **conversation-level
memory** that carries prior chat turns (user goals + agent answers) across
tasks within a single chat session. The agent can reference what was
discussed earlier ("book the cheapest one" after a search), conversation
history is compacted via LLM summarization when it grows long, and old
turns decay via FSRS-6 so stale context fades naturally.

## Problem

Today each chat message sends `POST /task { goal }` in isolation. The agent
has no memory of prior turns. Working context (`working-context.mjs`) was
designed to compact intra-task observations, but:

- It duplicates the local `observations[]` array that both strategies
  already maintain.
- Compaction (50-turn threshold) almost never fires because tasks finish
  well under that limit.
- It is created fresh per task run and destroyed when the task ends.
- It provides zero user-visible value.

## Design principles

1. **Two modes: `store` and `passthrough`.** In `store` mode, the server
   persists turns in SQLite/Cosmos; the client sends a `sessionId`. In
   `passthrough` mode, the caller sends `conversation[]` with each request
   and the server just injects it into prompts — no storage, no decay,
   no summarization. Config picks the mode.
2. **Reuse existing machinery.** In `store` mode, FSRS-6 decay engine,
   SQLite store adapter, and summarization patterns already exist —
   conversation context uses them, not new equivalents. In `passthrough`
   mode, no server-side machinery is needed.
3. **Graceful degradation.** Summarization fails → sliding window.
   Store fails → blank context. Missing `sessionId` or `conversation` →
   task runs without conversation context. The task always runs.
4. **Independently toggleable.** Enabled/disabled via `host.config.mjs`
   like every other module. Existing behavior when disabled is unchanged.

---

## 1. Conversation Turn Schema

Each turn stored in SQLite:

```js
{
  id:                 'ct-<uuid12>',       // unique turn id
  sessionId:          'ses-<uuid12>',      // groups turns into a conversation
  turnIndex:          0,                   // 0-based position in session
  goal:               'Find flights...',   // user's message
  answer:             'Here are...',       // agent's response (truncated to 500 chars)
  status:             'completed',         // completed | failed | cancelled
  createdAt:          '2026-09-28T...',    // ISO timestamp
  retrievalStrength:  1.0,                 // FSRS-6 managed
  stability:          1.0,                 // FSRS-6 managed
  state:              'active',            // active | dormant | silent | unavailable
  lastPromotedAt:     '2026-09-28T...',    // last time this turn was referenced
  summary:            null,                // compacted summary (set by compaction)
}
```

## 2. Conversation Store — Adapter Pattern

Follows the same pluggable adapter pattern as the memory store
(`host/memory/store/interface.mjs`). The conversation context module
never knows which backend is behind it — config picks the implementation.

### Store Interface Contract

```js
// host/memory/conversation-store/interface.mjs
export const CONVERSATION_STORE_METHODS = [
  'open',           // async () => void — connect, create dirs/tables/containers
  'close',          // async () => void — cleanup
  'append',         // async (turn) => void — insert a turn
  'get',            // async (id) => turn | null
  'update',         // async (id, patch) => turn — merge patch into existing turn
  'listSession',    // async (sessionId, { states?, limit? }) => turn[] — ordered by turnIndex
  'purgeSessions',  // async ({ olderThanDays }) => count — remove old sessions
];

export function assertConversationStore(store) {
  const missing = CONVERSATION_STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`conversation store missing: ${missing.join(', ')}`);
  return store;
}
```

### Store Resolution

Same pattern as `resolveStore()` in `host/memory/index.mjs`:

```
config.store = 'sqlite'      → createConversationSqliteStore(config)
config.store = 'cosmos'       → createConversationCosmosStore(config)
config.store = function       → config.store(config)   // custom adapter
default                       → createConversationSqliteStore(config)
```

### SQLite Implementation — `conversation-store/sqlite.mjs`

Table:

```sql
CREATE TABLE IF NOT EXISTS conversation_turns (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  turn_index          INTEGER NOT NULL,
  goal                TEXT NOT NULL,
  answer              TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL,
  retrieval_strength  REAL NOT NULL DEFAULT 1.0,
  stability           REAL NOT NULL DEFAULT 1.0,
  state               TEXT NOT NULL DEFAULT 'active',
  last_promoted_at    TEXT,
  summary             TEXT
);
CREATE INDEX IF NOT EXISTS idx_ct_session ON conversation_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_ct_state   ON conversation_turns(state);
```

### Cosmos Implementation — `conversation-store/cosmos.mjs`

Lazy-loaded (`await import(...)`) like the memory store's Cosmos adapter.
Uses `sessionId` as partition key. Same `open/close/append/get/update/
listSession/purgeSessions` contract.

### Future backends

Any backend that implements `CONVERSATION_STORE_METHODS` can be plugged in
via config. The interface contract and `assertConversationStore` validator
make this safe.

## 3. Conversation Context Module — `conversation-context.mjs`

Replaces `working-context.mjs`. Manages a single session's conversation
history with compaction and decay.

### Constructor

```js
createConversationContext({
  store,                // conversation SQLite store
  engine,               // FSRS-6 engine (reused from long-term)
  fleetApi,             // for LLM summarization calls
  maxRecentTurns: 6,    // keep this many recent turns verbatim
  maxTotalTurns: 20,    // cap total turns stored per session
  compactionStrategy: 'summarise',  // 'summarise' | 'sliding-window'
  answerMaxChars: 500,  // truncate stored answers
  logger,
})
```

### Lifecycle per chat turn

```
forPrompt(sessionId)
  1. Load turns for sessionId from store (states: active, dormant)
  2. Run decay pass — engine.computeRetrievability on each turn,
     update state if changed (active→dormant→silent)
  3. Drop silent/unavailable turns from the prompt set
  4. If remaining turns > maxRecentTurns:
     a. Partition: older = turns[0..-(maxRecentTurns)], recent = last N
     b. Summarise older turns via fleetApi.executePrompt
     c. If summarisation fails, fallback to sliding-window (keep recent only)
  5. Return formatted array:
     [{ role: 'summary', text: '...' }?,  // compacted summary if any
      { role: 'user', text: goal },        // recent turns...
      { role: 'assistant', text: answer }, ...]

recordTurn(sessionId, { goal, answer, status })
  1. Compute next turnIndex for this session
  2. Truncate answer to answerMaxChars
  3. Create turn entry with fresh FSRS-6 defaults
  4. If session turns >= maxTotalTurns, drop the oldest (lowest retrievalStrength)
  5. Store via store.append()

promoteTurn(sessionId, turnId)
  1. Load turn, run engine.processReview(turn, 3) — "Good" rating
  2. Update retrievalStrength, stability, lastPromotedAt
```

## 4. Passthrough Mode

In `passthrough` mode, the server does no storage, decay, or
summarization. The caller is responsible for managing conversation
history and sending it with each request.

### Request format

```js
POST /task {
  goal: 'Book the cheapest one',
  conversation: [
    { role: 'user', text: 'Find flights to Tokyo' },
    { role: 'assistant', text: 'Found 3 flights: JAL $800, ANA $750, United $900' },
  ]
}
```

### Server behavior

- `tasks.mjs` checks `task.conversation` (array of `{ role, text }` pairs).
- If present and the mode is `passthrough` (or mode is `store` but no
  `sessionId` was sent), the array is formatted directly into the
  `## Conversation History` prompt section.
- No turn is recorded, no decay runs, no store is opened.
- The array is capped at the configured `maxRecentTurns` (from the tail)
  to prevent prompt size abuse from API callers.

### When to use

- API callers who manage their own state
- Lightweight deployments that don't want a conversation DB
- Testing — send a canned conversation without setting up SQLite

## 5. Client Changes — `chat/app.mjs` (Store Mode)

### Session ID management (store mode)

- On page load, generate `sessionId = 'ses-' + crypto.randomUUID().slice(0,12)`.
- Store in `sessionStorage` so it survives in-tab refreshes but not new tabs
  (each tab = new conversation).
- Send with every task: `POST /task { goal, sessionId }`.

### Client-side passthrough (passthrough mode)

- Client accumulates `turns[]` array: on settled+completed, push
  `{ role: 'user', text: goal }` and `{ role: 'assistant', text: answer }`.
- Send with every task: `POST /task { goal, conversation: turns.slice(-maxTurns) }`.
- `sessionId` is not sent.

### Turn recording (store mode)

No change needed — the server records turns. The client just sends
`sessionId`.

## 6. Server Pipeline Changes

### `host/routes.mjs`

Pass `body.sessionId` through to `runSync(body)` / `jobs.submit(task)`.
No validation — optional field, undefined means no conversation context.

### `host/tasks.mjs` — `executeHostedTask`

Between memory recall and `runTask()`:

```
// Resolve conversation history — mode determines the source.
let conversationHistory = [];
const ccMode = memory?.conversationContext?.mode ?? null;

if (ccMode === 'store' && task.sessionId) {
  // Store mode: load from DB, run decay + compaction
  conversationHistory = await memory.conversationContext.forPrompt(task.sessionId);
} else if (ccMode === 'passthrough' && Array.isArray(task.conversation)) {
  // Passthrough mode: use caller-supplied array, cap at maxRecentTurns
  const max = memory.conversationContext.maxRecentTurns ?? 10;
  conversationHistory = task.conversation.slice(-max).map(c => ({
    role: c.role === 'user' ? 'turn' : c.role,
    goal: c.role === 'user' ? c.text : undefined,
    answer: c.role === 'assistant' ? c.text : undefined,
    ...c,
  }));
} else if (Array.isArray(task.conversation) && !ccMode) {
  // No mode configured but caller sent conversation — use it raw
  conversationHistory = task.conversation.slice(-10);
}

// ... runTask with conversationHistory

// After task completes (store mode only):
if (ccMode === 'store' && task.sessionId) {
  await memory.conversationContext.recordTurn(task.sessionId, {
    goal: task.goal,
    answer: result.result,
    status: result.status,
  });
}
```

### `host/prompts/system.mjs` — `buildSystemPrompt`

New optional `conversation` parameter. When present, inject after the
memory section, before response format:

```
## Conversation History

The user has been chatting with you. Here is the prior conversation:

[Summary of older turns]

User: <goal 1>
Agent: <answer 1>

User: <goal 2>
Agent: <answer 2>

Use this context to understand references like "the cheapest one",
"do that again", or "the place you mentioned".
```

### `host/run-loop.mjs`

Pass `conversationHistory` through to strategy constructors. Both
strategies receive it but don't interact with it — it's injected at
the prompt level only.

## 7. Removing Working Context

### Files to delete

- `host/memory/working-context.mjs`
- `tests/host-memory-working-context.test.mjs`

### Files to modify

- `host/memory/index.mjs` — remove `createWorkingContext` import, remove
  `workingContext` and `createRunWorkingContext` from the module.
- `host/run-loop.mjs` — remove `createRunWorkingContext` call, remove
  `runMemory.workingContext`.
- `host/strategies/plan-execute.mjs` — remove `memory.workingContext.append()`
  and `memory.workingContext.forPrompt()`, use local `observations` directly.
- `host/strategies/open-ended.mjs` — same removal.
- `host/config.mjs` — remove `workingContext` warning.
- `host.config.mjs` — remove `workingContext` from config, add
  `conversationContext` section.

## 8. Configuration

```js
// host.config.mjs → modules.memory

// Option A: Store mode — server persists turns, client sends sessionId
{
  conversationContext: {
    enabled: true,
    mode: 'store',                      // 'store' | 'passthrough'
    store: 'sqlite',                    // 'sqlite' | 'cosmos' | function
    dbPath: './memory/conversation.db', // sqlite only
    cosmos: {                           // cosmos only — same shape as longTerm.cosmos
      endpoint: '${COSMOS_ENDPOINT}',
      key: '${COSMOS_KEY}',
      database: 'agent-kit',
      container: 'conversations',
    },
    maxRecentTurns: 6,
    maxTotalTurns: 20,
    compactionStrategy: 'summarise',
    answerMaxChars: 500,
    decay: { mode: 'on-recall' },
  },
}

// Option B: Passthrough mode — caller sends conversation[], no storage
{
  conversationContext: {
    enabled: true,
    mode: 'passthrough',
    maxRecentTurns: 10,                 // cap on incoming array length
  },
}
```

`mode` defaults to `'store'` if omitted, preserving the full server-side
lifecycle. In `passthrough` mode, only `maxRecentTurns` is relevant — the
store/decay/compaction settings are ignored.

Store resolution follows the same `resolveStore` pattern as long-term
memory: string selects a built-in adapter, function receives the config
and returns a custom adapter. The `assertConversationStore` validator
ensures the adapter implements all required methods.

## 9. Memory Event Integration

Emit via existing `createMemoryEvents`:

- `memory:conversation:recall` — `{ sessionId, turnCount }` when context is
  loaded for a prompt
- `memory:conversation:store` — `{ sessionId, turnId }` when a turn is
  recorded
- `memory:conversation:compact` — `{ sessionId, strategy, survivingTurns }`
  when compaction runs

These flow through SSE to the chat UI via the existing progress event
pipeline. The UI can optionally show a "CONVERSATION CONTEXT" indicator
(similar to RECALLED MEMORIES panel) — but this is a nice-to-have, not
required for V1.

## 10. What stays unchanged

- **Run state** — crash recovery for single tasks, unmodified.
- **Long-term memory** — cross-session facts with decay, unmodified.
- **Learner** — still extracts facts after task completion, unmodified.
- **`observations[]`** in both strategies — still tracks intra-task tool
  results, used directly for `historyForPrompt()`.
- **Dedup gate** — not used for conversation turns (each turn is unique).
- **Memory store adapter pattern** — conversation store defines its own
  interface contract (`CONVERSATION_STORE_METHODS`) following the same
  adapter pattern, but with a different method set suited to session-scoped
  turns rather than kind/tag-based memory entries.

## 11. Testing strategy

- **Unit tests** for `conversation-store.mjs` — CRUD, session listing,
  purge, state filtering.
- **Unit tests** for `conversation-context.mjs` — compaction (summarise
  + fallback), decay state transitions, turn recording, max turns cap,
  answer truncation.
- **Integration test** — full pipeline: chat sends `sessionId`, task
  runs, turn is recorded, next task sees prior context in prompt.
- **Existing tests** — must pass after working-context removal. Run full
  suite to verify no regressions.
