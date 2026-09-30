# Azure state storage: Durable Entities as the default

**Status:** draft for approval — no code written
**Date:** 2026-09-30
**Supersedes the storage half of:** `docs/specs/2026-09-29-memory-human-input-integration-spec.md`
**Branch it builds on:** `feature/memory-human-input-integration`

---

## 1. The correction this spec starts from

An earlier answer in this workspace said the Durable task hub cannot hold the
checkpoint, chat history or long-term facts. **That was wrong**, and the
correction stands: it reasoned only about orchestration *input and output*.
Durable Entities are a separate feature — addressable, durable objects that
live in the task hub's own storage, keyed by entity ID, outliving any single
orchestration.

Verified in this checkout, not assumed:

```
durable-functions 3.5.0
df.app.entity        → function
df.EntityId          → exported
lib/src/entities/    → Entity, EntityId, EntityState, Signal, DurableLock, …
```

So entity-backed storage is available on the version already installed. No
dependency change is needed for entities themselves.

---

## 2. The three questions, answered

### (a) What does `pause_too_large` guard — output or custom status?

**The orchestration output.** `comm/azure-functions/orchestrator.mjs:81` returns
`guardPausedOutput(output, jobId)`, and that function (`:102`) measures
`JSON.stringify(output)` against `DURABLE_PAYLOAD_MAX_CHARS = 12_000`, commented
"stay safely under the 16 KB UTF-16 limit".

`customStatus` is a *different* thing and is not what the guard covers. The
orchestrator keeps it deliberately small — a ring of 50 events
(`ringEvents(events, ringSize)`) — and the code states the contract outright:

> `customStatus` has a hard size limit and is a live view, never a source of
> truth — the state is in the output.

One thing that changed under you today: as of commit `d8235ae` on this branch,
the paused output is already a pointer (`{ status, batchId, batch, checkpointKey }`),
so `pause_too_large` is now an unreachable assertion rather than a live failure
path. It was deliberately kept as an assertion: if it ever fires, something has
started putting state back in the output.

### (b) Which Durable backend, and its payload limits?

**Azure Storage** — the default provider. `comm/azure-functions/host.json`
declares only:

```json
"extensions": { "durableTask": { "hubName": "%DURABLE_TASK_HUB%" } }
```

There is no `storageProvider` block, so it is not Netherite, not MSSQL, and not
the Durable Task Scheduler. Extension bundle `[4.*, 5.0.0)`. The e2e harness
points `AzureWebJobsStorage` at Azurite (blob 10000 / queue 10001 / table 10002).

**On the limits, I am deliberately not asserting a number.** The 16 KB figure in
our code is our own conservative choice, not a quoted Azure limit, and the
Azure Storage provider's actual behaviour around large payloads (queue-message
caps, automatic blob offloading, and what applies to *entity state* specifically
as opposed to messages) is the one thing in this spec I could not verify from
the repo. **This must be measured on a real Azurite run before the design
depends on it** — see the spike in §5. Designing to an unverified limit is how
`pause_too_large` came to exist in the first place.

### (c) Do long-term facts need search?

**Yes — query, not key lookup.** `host/memory/long-term.mjs:99` recalls via:

```js
store.query({ kinds: ['rule'], states: ['active'] })
store.query({ kinds: nonRuleKinds, tags, states: ['active'], limit: room })
```

That is a multi-predicate filter (kind ∈ set, tag membership, state ∈ set,
limit), followed by a sort on `retrievalStrength`. The full required surface is:

```js
MEMORY_STORE_METHODS = ['open','close','store','get','update','remove','query','purge','count']
```

`count({})` backs the `maxEntries` cap (500 by default) and `purge` backs the
decay sweep — both cross-cutting operations over the whole fact set, not
per-key.

**This is satisfiable by an entity but it is the weakest fit of the three.** A
per-user entity holds ≤500 facts and filters in memory; correctness is fine.
The cost is that *every* recall loads the whole entity state and *every* store
rewrites it. That is the operation whose latency and state size will cross a
threshold first, which is exactly what your "when to switch to Cosmos or SQL"
alert list is for. My recommendation in §4.

---

## 3. What the plan asks for that already exists

Three of the six implementation rules are already true on this branch, so they
should be struck from the work rather than re-done:

| Rule | Status |
|---|---|
| 4. Idempotency keys on irreversible steps | **Exists** — `stepIdempotencyKey()`, `host/checkpoint/record.mjs` |
| Checkpoint written after each step | **Exists** — both strategies, `saveCheckpoint(i, key)` |
| Jobs stay on the task hub | **Exists** — `AUTO = { durable: 'taskhub' }` |

**One correction on rule 4.** The proposed key format `convId:stepN` is *weaker*
than what shipped today. Today's key is `${tool}-${sha256(scrub(args))}-${i}` —
it includes a hash of the step's scrubbed arguments. `convId:stepN` omits them,
so after a replan (which this kit does, up to `maxReplanAttempts`) a *different*
step occupying index N would match the old key and be **silently skipped as
already done**. The args must stay in the key. The scrubbing is also
load-bearing: it was added today because a credential in a step argument was
being written verbatim into the stored key.

---

## 4. Design

### 4.1 Adapter shape

Three new adapters behind the two existing interfaces — no caller changes:

```
host/memory/store/entity.mjs               → MEMORY_STORE_METHODS  (checkpoint + long-term)
host/memory/conversation-store/entity.mjs  → CONVERSATION_STORE_METHODS
host/memory/store/sql.mjs + conversation-store/sql.mjs  → the new SQL option
```

Selection stays config-only, via the existing `resolveStore` switch:

```js
memory: {
  checkpoint:          { enabled: true, store: 'entity' },
  conversationContext: { enabled: true, store: 'entity', mode: 'store' },
  longTerm:            { enabled: true, store: 'entity' },   // see §4.4
}
```

### 4.2 Entity keying

| Store | Entity name | Key | Lifetime |
|---|---|---|---|
| Checkpoint | `checkpoint` | `cp-<jobId>` | cleared on settle |
| Conversation | `conversation` | `<sessionId>` | retention job |
| Long-term facts | `facts` | `<personId>` (or `global`) | retention job |

The checkpoint key already exists and is already computed this way
(`checkpointKey({ id: jobId })`), so the pointer in the paused output needs no
change — only something on the other end that reads it from an entity rather
than a memory store.

### 4.3 Who writes, and how

Per your rule 2: **`callEntity` from the orchestrator only.** `signalEntity` is
fire-and-forget and gives no confirmation, so a crash between signal and
execution loses the checkpoint silently — the exact failure the checkpoint
exists to prevent. Activities do not write entities.

### 4.4 Long-term facts: my recommendation

**Default long-term facts to Cosmos, not entities**, while checkpoint and
conversation default to entities.

Facts are the one store with a genuine cross-cutting query (kind × tags × state,
plus `count` and `purge` sweeps over everything), the one whose state only ever
grows, and the one that is *not* scoped to a single conversation — so it gets
none of the locality benefit entities give the other two. Putting it on entities
means loading ~500 facts to answer every recall, on every run.

This is a recommendation, not a decision — it is Open Question 1.

---

## 5. The blocker: the orchestrator can currently yield only once

**This is the item most likely to sink the plan, and it needs a spike before
anything else is built.**

Plan rule 2 — "split each irreversible step into its own activity and record the
checkpoint in the orchestrator after it returns" — requires the orchestrator to
yield many times per run: one `callActivity` per step, plus one `callEntity` per
checkpoint. The orchestrator today yields **exactly once**, on purpose, and the
reason is a scar (`comm/azure-functions/orchestrator.mjs:50-55`):

> Single yield — one activity, one dispatch. The previous `for(;;)` loop
> consumed `waitForExternalEvent('progress')` events, but each replay shifted
> the Durable SDK's event-ID counter, causing `callActivity()` to schedule a
> **NEW** activity on every replay instead of matching the original. Result:
> N progress events → N+1 activities → worker pool exhaustion.

**My read:** multi-yield is the normal Durable pattern — sequential activities
and fan-out/fan-in are textbook — so the bug was almost certainly the
*interleaving* of externally-raised `progress` events with `callActivity` in a
loop, not multi-yield itself. Removing the progress-event channel should fix it.
But "almost certainly" is not good enough given this repo already lost a worker
pool to it once, and given the Azure path has **never been run end to end**
(see §7).

**Spike, before any other work:** a throwaway orchestrator that yields
`callActivity` three times and `callEntity` twice against Azurite, with progress
events removed; assert exactly three activity executions across replays. If it
fails, §6 is the fallback.

### 5.1 The architectural cost nobody has priced yet

Even if the spike passes, moving per-step control into the orchestrator is a
**large** change, and larger than the plan's wording suggests:

- Today the run loop lives in the **activity**: `activity.mjs` → `executeHostedTask`
  → the strategy, which owns the plan/execute loop.
- Those strategies are **shared with the VM path**. One code path, two
  deployments — that is what makes the black-box e2e suite able to prove both.
- The plan isn't known until an LLM produces it, *inside* an activity. So the
  shape becomes `activity(plan)` → orchestrator loops → `activity(step)` × N,
  and the orchestrator becomes a second plan-execute loop that exists only on
  Azure.

That forks the execution model between VM and Functions. It is defensible — it
buys per-step durability that a single long activity cannot give — but it should
be an explicit decision, not a side effect of a storage change. It is Open
Question 2.

---

## 6. Fallback if the spike fails

Keep the single activity, and have the activity write checkpoints through an
**HTTP call to an entity** via the Durable client binding (`signalEntity` plus a
read-back to confirm, or the entity-state REST endpoint). Slower and less
elegant than `callEntity`, and it violates plan rule 2 — but it keeps the
one-activity model, keeps VM and Azure on the same strategies, and still puts
the state in the task hub.

---

## 7. What is not verified, and cannot be here

`npm run e2e:durable` has **never been run**. Docker is not installed on this
machine, so every Azure claim in this repo — including the pointer fix committed
today — is unit-tested against mocks only. Mocks prove the orchestrator's
*shape*, not that a pause survives a genuinely completed orchestration.

**Nothing in this spec should be built until `e2e:durable` runs green on the
current branch on a machine with Docker.** Otherwise we would be layering
entities on top of an Azure path whose basic pause/resume has never executed.

Your rule 6 is right, though, and cheap to confirm: entities use the same
storage account, so the Azurite harness should need no change.

---

## 8. Out of scope

- Large tool results → blob storage with a reference in the entity (plan rule 5).
  Worth doing, but it is a separate change from *where state lives*, and it has
  its own retention and cleanup story.
- The migration job. New conversations to the new store, existing ones finishing
  on entities, is enough.
- MCP provenance in the checkpoint — still out of scope, carried from the
  previous spec.

---

## 9. Open questions

1. **Long-term facts: entities or Cosmos by default?** §4.4 recommends Cosmos —
   it is the only store with a real cross-cutting query and unbounded growth.
   Entities would work but load ~500 facts per recall.
2. **Do we accept forking the execution model?** Per-step activities give real
   per-step durability but put a second plan-execute loop in the orchestrator,
   Azure-only, diverging from the VM path that shares the strategies today.
3. **SQL adapter — which SQL?** Azure SQL, or SQL Server generally? It decides
   the driver dependency (`mssql` vs `tedious`) and whether it can be
   lazy-loaded the way the Cosmos adapter is.

---

## 10. Recommended order

1. Get `e2e:durable` green on the current branch (needs Docker). **Gate.**
2. Spike the multi-yield orchestrator (§5). **Gate.**
3. Resolve Open Questions 1–3.
4. Entity adapter for the checkpoint — smallest, clearest win, one key, cleared
   on settle.
5. Entity adapter for the conversation store.
6. Long-term facts, per the answer to Q1.
7. SQL adapter behind the same interface.
8. Retention job for entities.
