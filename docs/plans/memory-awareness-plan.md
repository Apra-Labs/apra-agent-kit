# Memory Awareness Implementation Plan

> **Prerequisite:** The conversation context plan (`docs/plans/conversation-context-plan.md`) must be implemented first. This plan assumes `workingContext` has been removed and `conversationContext` is live.

**Goal:** Make the memory system visible and configurable in the two developer-facing surfaces — the npm scaffold template and the agent-builder skill — so that new projects and AI-generated specs/plans include memory configuration.

**Spec:** `docs/specs/memory-awareness-spec.md`

**Tech Stack:** Markdown, JavaScript (ESM), existing test framework (`node:test` + `assert/strict`)

## Global Constraints

- No new runtime dependencies — all changes are documentation, templates, and skill text.
- Existing tests must continue to pass — template copy tests may need content updates.
- The conversation context feature must be merged before this work begins.
- All memory config uses `conversationContext` (not `workingContext`).

---

### Task 1: Update npm Template — `host.config.mjs`

**Files:**
- Modify: `template/host.config.mjs`
- Test: `tests/create-copy.test.mjs` (verify template copies correctly)

- [ ] **Step 1: Read the current template and copy test**

Read: `template/host.config.mjs`, `tests/create-copy.test.mjs`

- [ ] **Step 2: Replace `template/host.config.mjs`**

Replace the bare-bones config with a full `modules` block. All core modules (runLoop, budgets, guardrails, dispatch, notify, chat, router) are enabled. Memory is present but commented out with explanatory comments showing all three tiers.

```js
// Host configuration for {{PROJECT_NAME}}.
// See docs/getting-started.md for a walkthrough of each option.
export default {
  name: '{{PROJECT_NAME}}',
  description: 'A Fleet agent built with the workflow kit.',

  agentDescription: `Describe your agent's domain expertise, which tools to use
and when, and any domain-specific rules. This becomes the system prompt extension
the LLM sees before every task. Be directive — "ALWAYS use the X tool" is better
than "you can use X".`,

  fleet: {},

  comm: {
    adapter: 'express',
  },

  modules: {
    runLoop: {
      enabled: true,
      strategy: 'plan-execute',
      maxReplanAttempts: 3,
      maxReviewAttempts: 2,
      maxStepReviewAttempts: 2,
      minReviewPolicy: 'irreversible',
      maxNoActionTurns: 3,
    },
    budgets: {
      enabled: true,
      maxIterations: 25,
      maxCostUsd: 5.00,
      maxTokens: 500_000,
      timeoutMs: 600_000,
    },
    guardrails: {
      enabled: true,
      defaultPolicy: 'allow',
      validateInputs: true,
      dryRunMode: false,
    },
    dispatch: {
      enabled: true,
      store: { kind: 'sqlite', dbPath: './jobs.db' },
      concurrency: 2,
      maxQueueSize: 10,
    },
    notify: {
      sse: { enabled: true },
    },
    chat: {
      enabled: true,
      title: '{{PROJECT_NAME}}',
      themes: ['apra'],
    },
    router: {
      enabled: true,
      fallbackStrategy: 'open-ended',
    },

    // -- Memory (uncomment tiers you need) --
    //
    // memory: {
    //   // Conversation context — carries prior chat turns across tasks in a session.
    //   // The agent can reference earlier results ("book the cheapest one").
    //   conversationContext: {
    //     enabled: true,
    //     mode: 'store',                      // 'store' (server persists) or 'passthrough' (caller sends history)
    //     store: 'sqlite',
    //     dbPath: './memory/conversation.db',
    //     maxRecentTurns: 6,                  // verbatim turns in prompt
    //     maxTotalTurns: 20,                  // cap per session
    //     compactionStrategy: 'summarise',    // 'summarise' or 'sliding-window'
    //     answerMaxChars: 500,
    //   },
    //
    //   // Run state — crash recovery for interrupted tasks.
    //   runState: {
    //     enabled: true,
    //     store: 'sqlite',
    //     dbPath: './memory/run-state.db',
    //   },
    //
    //   // Long-term memory — cross-session facts with FSRS-6 decay.
    //   // Adds remember/recall/forget/promote tools to the agent.
    //   longTerm: {
    //     enabled: true,
    //     store: 'sqlite',
    //     dbPath: './memory/memory.db',
    //     autoLearn: true,                    // extract facts after each task
    //     decay: { mode: 'auto', intervalMs: 120_000 },
    //     dedup: { enabled: true },
    //     recallLimit: 20,
    //     maxEntries: 500,
    //   },
    // },
  },
};
```

- [ ] **Step 3: Run template copy tests**

Run: `node --test tests/create-copy.test.mjs`
If tests check specific content of `host.config.mjs`, update assertions to match the new template. The test should verify the file exists and contains `{{PROJECT_NAME}}` substitution markers.

- [ ] **Step 4: Commit**

```
git add template/host.config.mjs tests/create-copy.test.mjs
git commit -m "feat(template): add full modules block with commented-out memory config"
```

---

### Task 2: Update npm Template — `.gitignore` and `README.md`

**Files:**
- Modify: `template/gitignore`
- Modify: `template/README.md`
- Test: `tests/create-copy.test.mjs`

- [ ] **Step 1: Update `template/gitignore`**

Add memory DB patterns after the existing entries:

```
memory/*.db
memory/*.db-shm
memory/*.db-wal
```

- [ ] **Step 2: Update `template/README.md`**

Add a Memory section after the "Your code and the kit's" table. Keep it brief — point to `docs/getting-started.md` for details.

Add to the capabilities table:

```markdown
| `host.config.mjs` → `modules.memory` | Optional three-tier memory system |
```

Add a new section:

```markdown
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

See [docs/getting-started.md](docs/getting-started.md) for configuration details.
```

- [ ] **Step 3: Run tests**

Run: `node --test tests/create-copy.test.mjs`
Expected: PASS.

- [ ] **Step 4: Commit**

```
git add template/gitignore template/README.md
git commit -m "feat(template): add memory DB to gitignore and memory section to README"
```

---

### Task 3: Update Agent-Builder Skill — Interview + Grilling

**Files:**
- Modify: `.claude/skills/agent-builder/SKILL.md`

- [ ] **Step 1: Read the current SKILL.md**

Read: `.claude/skills/agent-builder/SKILL.md`

- [ ] **Step 2: Update Phase 1 Round 4**

Rename Round 4 from "Workflow + Members" to "Workflow + Members + Memory".

Add a third question to the Round 4 AskUserQuestion call:

```
> Q3: "Does this agent need memory across conversations?"
> Multiple choice:
> - **No memory** — "Each task is independent. No state persists between
>   conversations or even between messages in the same chat."
> - **Conversation context only** — "Remember what was discussed in this
>   chat session so the user can say things like 'book the cheapest one'
>   after a search."
> - **Long-term memory** — "Learn and remember facts across sessions —
>   user preferences, domain knowledge, patterns. The agent gets
>   remember/recall/forget/promote tools."
> - **Both** — "Conversation context within a session + long-term memory
>   across sessions."
```

- [ ] **Step 3: Update Phase 1 Stage B — Grilling signals table**

Add memory-specific rows to the "Adapt questions based on wizard signals" table:

```markdown
| Conversation context (Q7) | How long are typical sessions? How many turns before context gets stale? Should old context be summarised by the LLM or just dropped? |
| Long-term memory (Q7) | What kinds of facts should it learn — user preferences, domain rules, patterns? Should it learn from user corrections automatically? At what point does stored knowledge become noise? |
| Both (Q7) | Should conversation turns that contain reusable facts get promoted to long-term memory? Or are the two tiers independent? |
```

- [ ] **Step 4: Verify the skill loads**

Open Claude Code, type `/agent-builder`, verify Phase 0 runs without error. (Manual check — no automated test for skill content.)

- [ ] **Step 5: Commit**

```
git add .claude/skills/agent-builder/SKILL.md
git commit -m "feat(agent-builder): add memory interview question and grilling signals"
```

---

### Task 4: Update Agent Spec Template

**Files:**
- Modify: `.claude/skills/agent-builder/references/agent-spec-template.md`

- [ ] **Step 1: Read the current template**

Read: `.claude/skills/agent-builder/references/agent-spec-template.md`

- [ ] **Step 2: Add Memory Configuration section**

Insert between "Host Configuration → Modules" and "Error Handling & Edge Cases":

```markdown
## Memory Configuration

{{Fill based on interview memory question. Omit this entire section if "No memory".}}

{{If conversation context:}}
### Conversation Context
- **Mode**: {{store — server persists turns in SQLite/Cosmos, client sends sessionId; or passthrough — caller sends conversation[] with each request}}
- **Store**: {{sqlite or cosmos}}
- **Max recent turns**: {{number of verbatim turns kept in prompt, default 6}}
- **Max total turns**: {{cap per session before oldest are evicted, default 20}}
- **Compaction**: {{summarise — LLM summarises old turns; or sliding-window — just drop them}}
- **Answer truncation**: {{max chars for stored answers, default 500}}

{{If long-term memory:}}
### Long-Term Memory
- **Store**: {{sqlite or cosmos}}
- **Auto-learn**: {{true — learner extracts facts after each task; or false — only explicit remember tool calls}}
- **Decay**: {{auto with intervalMs — timer-based; or on-recall — decay runs when facts are queried}}
- **Dedup**: {{enabled — reject duplicate facts; or disabled}}
- **Max entries**: {{cap before oldest decayed entries are purged}}
- **Preload directory**: {{path to .md files with seed knowledge, or "none"}}
- **Memory tool coaching**: {{what the agentDescription should say about when to use remember/recall — e.g. "ALWAYS recall relevant knowledge before planning"}}

### Run State
- **Enabled**: {{true for crash recovery, false if not needed}}
- **Store**: {{sqlite — same adapter as long-term}}
```

- [ ] **Step 3: Update the Modules list**

In the existing "### Modules" subsection under "Host Configuration", add memory:

```markdown
- **memory**: {{if applicable — conversationContext (mode, store), runState (enabled), longTerm (enabled, autoLearn, decay, dedup)}}
```

- [ ] **Step 4: Commit**

```
git add .claude/skills/agent-builder/references/agent-spec-template.md
git commit -m "feat(agent-builder): add memory section to spec template"
```

---

### Task 5: Update Kit File Conventions — Memory Documentation

**Files:**
- Modify: `.claude/skills/agent-builder/references/kit-file-conventions.md`

This is the largest task — the conventions reference is the authoritative
documentation the writing-plans skill uses to map spec sections to files.

- [ ] **Step 1: Read the current conventions**

Read: `.claude/skills/agent-builder/references/kit-file-conventions.md`

- [ ] **Step 2: Add Memory Module Configuration section**

Insert after "Host Configuration" and before "API Key Propagation". This documents
the `modules.memory` config shape:

```markdown
## Memory Module Configuration

The `modules.memory` block in `host.config.mjs` configures three independent tiers.
All are optional — omit the entire `memory` block if the agent doesn't need memory.

```javascript
modules: {
  // ... other modules ...

  memory: {
    // Tier 1: Conversation context — carries prior chat turns across tasks
    // within a single browser/API session.
    conversationContext: {
      enabled: true,
      mode: 'store',                      // 'store' | 'passthrough'
      store: 'sqlite',                    // 'sqlite' | 'cosmos' | function
      dbPath: './memory/conversation.db', // sqlite only
      maxRecentTurns: 6,                  // verbatim turns in prompt
      maxTotalTurns: 20,                  // cap per session
      compactionStrategy: 'summarise',    // 'summarise' | 'sliding-window'
      answerMaxChars: 500,                // truncate stored answers
    },

    // Tier 2: Run state — crash recovery for interrupted tasks.
    runState: {
      enabled: true,
      store: 'sqlite',
      dbPath: './memory/run-state.db',
    },

    // Tier 3: Long-term memory — cross-session facts with FSRS-6 decay.
    longTerm: {
      enabled: true,
      store: 'sqlite',                   // 'sqlite' | 'cosmos' | 'filesystem' | function
      dbPath: './memory/memory.db',      // sqlite only
      dir: './memory',                   // filesystem only
      autoLearn: true,                   // learner extracts facts after each task
      decay: {
        mode: 'auto',                    // 'auto' (timer) | 'on-recall'
        intervalMs: 120_000,             // auto mode only
      },
      dedup: { enabled: true },          // reject duplicate facts
      recallLimit: 20,                   // max facts returned per recall
      maxEntries: 500,                   // cap before purge
      preloadDir: './knowledge',         // optional — seed .md files loaded on startup
    },
  },
}
```

### Mode selection

| Mode | When to use |
|---|---|
| `store` | Chat UI agents where the server manages session state. Client sends `sessionId`. |
| `passthrough` | API callers who manage their own history. Client sends `conversation[]`. No DB. |

### Store selection

| Store | When to use |
|---|---|
| `sqlite` | Local dev, single-instance deployments. Uses `node:sqlite` `DatabaseSync`. |
| `cosmos` | Azure deployments. Lazy-loaded `@azure/cosmos`. Partition key: `id` (long-term) or `sessionId` (conversation). |
| `filesystem` | Simplest option. JSON files in a directory. Long-term memory only. |
| function | Custom adapter. Receives config, must return an object implementing the store contract. |
```

- [ ] **Step 3: Add Memory Tools section**

Insert after "Memory Module Configuration":

```markdown
## Memory Tools

When long-term memory is enabled, the host automatically registers four tools
via `withMemoryTools()` from `host/tools/memory-tools.mjs`. No registry entry
is needed — they appear alongside your custom tools.

| Tool | Description | Input |
|------|------------|-------|
| `remember` | Store a fact in long-term memory | `{ text, kind, tags? }` |
| `recall` | Retrieve relevant facts | `{ tags?, kinds?, query?, limit? }` |
| `forget` | Remove a fact by ID | `{ id }` |
| `promote` | Mark a fact as useful (strengthens it against decay) | `{ id }` |

### Fact kinds

The `kind` field categorises facts for retrieval:

| Kind | Use for |
|------|---------|
| `domain` | Domain-specific knowledge (e.g. "Tokyo Narita has 3 terminals") |
| `preference` | User preferences (e.g. "user prefers window seats") |
| `pattern` | Recurring patterns (e.g. "flights to Osaka are cheapest on Tuesdays") |
| `procedure` | How-to knowledge (e.g. "to book JR Pass, use the online portal first") |

### agentDescription coaching

When memory is enabled, the `agentDescription` in `host.config.mjs` should coach
the LLM to use the memory tools. Examples:

```
// For an agent that should always check memory before planning:
ALWAYS use the recall tool at the start of each task to check for relevant
prior knowledge about the destination, user preferences, or known patterns.
Use the remember tool to store useful facts you discover during research.

// For an agent that should learn from corrections:
When the user corrects your output or provides a preference, use the remember
tool to store it as a 'preference' fact so you apply it in future conversations.
```

### Memory preloader

If `longTerm.preloadDir` is configured, the host loads `.md` files from that
directory on startup. Each file becomes a long-term memory entry with kind
`domain`. Duplicates are skipped.

```
knowledge/
├── city-guides.md       → stored as domain fact
├── visa-requirements.md → stored as domain fact
└── booking-rules.md     → stored as domain fact
```
```

- [ ] **Step 4: Add Conversation Store section**

Insert after "Memory Tools":

```markdown
## Conversation Store

The conversation context module uses its own store interface, separate from the
long-term memory store. Both follow the adapter pattern but have different method
contracts because they manage different data shapes.

### Store interface

File: `host/memory/conversation-store/interface.mjs`

Required methods: `open`, `close`, `append`, `get`, `update`, `listSession`,
`purgeSessions`.

### SQLite implementation

File: `host/memory/conversation-store/sqlite.mjs`

Table: `conversation_turns` with columns: `id`, `session_id`, `turn_index`,
`goal`, `answer`, `status`, `created_at`, `retrieval_strength`, `stability`,
`state`, `last_promoted_at`, `summary`.

Indexes: `idx_ct_session` (session_id), `idx_ct_state` (state).

### Cosmos implementation

File: `host/memory/conversation-store/cosmos.mjs`

Lazy-loaded. Partition key: `sessionId`.
```

- [ ] **Step 5: Update Build Order**

Replace the existing build order list:

```markdown
## Build Order

When generating an implementation plan from a spec, tasks should follow this order
so the project stays runnable at every step:

1. **Tools** — no dependencies, pure Python scripts
2. **Workflows** — depend on tools, follow the triad pattern
3. **Registry** — imports workflows/tools, wires MCP interface
4. **Host config** — `host.config.mjs` with agentDescription, modules, strategy
5. **Memory config** — configure `modules.memory` tiers (conversation context,
   run state, long-term), set up preload directory if needed, add memory tool
   coaching to `agentDescription`
6. **Tests** — verify each piece with mock-fleet
7. **Deployment** — Docker, env vars, compose updates
8. **Documentation** — generate `README.md` from the spec (see Agent README section)
9. **Session cleanup + integration test** — clear stale sessions, then end-to-end run
```

- [ ] **Step 6: Update agentDescription Tips**

In the existing "### `agentDescription` tips" section, add:

```markdown
- If long-term memory is enabled, coach the LLM to use memory tools:
  "ALWAYS use the recall tool before starting a task to check for relevant
  prior knowledge. Use the remember tool to store useful facts."
- If conversation context is enabled, no agentDescription coaching is needed —
  prior turns are injected into the system prompt automatically.
- If both are enabled, distinguish their purposes: conversation context is
  "what we just discussed", long-term memory is "what I've learned over time".
```

- [ ] **Step 7: Update Agent README template**

In the "Agent README → Structure" section, add a Memory row to the structure:

```markdown
## Memory

<If memory is configured: which tiers are enabled, what the agent remembers,
what memory tools are available. If not: "Memory is not configured for this agent.
See `host.config.mjs` to enable it.">
```

And in the Rules subsection, add:

```markdown
- If memory is enabled, document which tiers and what the agent learns
```

- [ ] **Step 8: Commit**

```
git add .claude/skills/agent-builder/references/kit-file-conventions.md
git commit -m "feat(agent-builder): document memory system in kit-file-conventions"
```

---

### Task 6: Update Getting-Started Guide

**Files:**
- Modify: `docs/getting-started.md`

- [ ] **Step 1: Read the current guide**

Read: `docs/getting-started.md`

- [ ] **Step 2: Update config reference table**

In the "### Config reference" table, add memory rows:

```markdown
| `memory.conversationContext` | Carries chat turns across tasks within a session. Mode: `store` (server persists) or `passthrough` (caller sends) |
| `memory.runState` | Crash recovery — resumes interrupted tasks from the last checkpoint |
| `memory.longTerm` | Cross-session fact storage with FSRS-6 decay. Adds `remember`/`recall`/`forget`/`promote` tools |
```

- [ ] **Step 3: Add Memory section**

Insert after "### Choosing a strategy" and before "### Config reference":

```markdown
### Memory (optional)

The kit has a three-tier memory system. All tiers are off by default — enable
what you need in `modules.memory`.

**Conversation context** — the agent remembers what was discussed earlier in
the chat session. Enable it when your agent handles multi-turn conversations
where users reference prior results ("book the cheapest one").

```js
memory: {
  conversationContext: {
    enabled: true,
    mode: 'store',         // server persists turns; client sends sessionId
    store: 'sqlite',
    dbPath: './memory/conversation.db',
  },
}
```

**Long-term memory** — the agent learns facts across sessions. When enabled,
the agent gains four tools: `remember`, `recall`, `forget`, `promote`. Coach
the agent to use them via `agentDescription`:

```js
memory: {
  longTerm: {
    enabled: true,
    store: 'sqlite',
    dbPath: './memory/memory.db',
    autoLearn: true,       // extract facts after each task
  },
}
```

```
// In agentDescription:
ALWAYS use the recall tool before planning to check for relevant
prior knowledge. Use remember to store useful facts you discover.
```

**Run state** — crash recovery. If a task is interrupted mid-execution,
it resumes from the last checkpoint on restart.

```js
memory: {
  runState: {
    enabled: true,
    store: 'sqlite',
    dbPath: './memory/run-state.db',
  },
}
```
```

- [ ] **Step 4: Update guided-path benefits list**

In the "### Guided path: `/agent-builder`" section, add a bullet to the list
of "things that are easy to forget when building manually":

```markdown
- **Memory configuration** — if the agent needs memory, sets up the right
  tiers (conversation context, long-term, run state) and coaches the LLM
  to use memory tools via `agentDescription`
```

- [ ] **Step 5: Update "What you get" list**

In the opening "What you get" section, add:

```markdown
- Remember prior chat turns and learn facts across sessions (optional memory)
```

- [ ] **Step 6: Commit**

```
git add docs/getting-started.md
git commit -m "docs: add memory section to getting-started guide"
```

---

### Task 7: Run Full Test Suite + Verify Template Scaffold

**Files:**
- Test: all test files
- Verify: scaffold a test project and inspect output

- [ ] **Step 1: Run all tests**

Run: `npm test`
Expected: All existing tests PASS.

Run: `node --test tests/create-copy.test.mjs tests/create-template.test.mjs tests/create-cli.test.mjs`
Expected: All template/create tests PASS.

- [ ] **Step 2: Scaffold a test project**

```bash
cd $TEMP
node C:\2_WorkSpace\Apra-Fleet-Agents\workflow-kit\bin\create.mjs test-memory-agent
```

Verify:
- `test-memory-agent/host.config.mjs` contains the commented-out `memory` block
- `test-memory-agent/.gitignore` contains `memory/*.db` patterns
- `test-memory-agent/README.md` mentions memory
- The `{{PROJECT_NAME}}` placeholder is replaced with `test-memory-agent`

Clean up the test project.

- [ ] **Step 3: Commit (if any test fixes were needed)**

```
git add -A
git commit -m "fix: update tests for new template content"
```

---

### Task 8: Update Conversation Context Plan Reference

After conversation context is implemented and this plan is complete, verify
that the conversation context plan's Task 5 (`.gitignore` update) is
redundant with what the template now ships. The main repo `.gitignore`
already has `memory/*.db` patterns. The template `.gitignore` now also has
them. No further action needed — this is a verification step only.

- [ ] **Step 1: Verify `.gitignore` coverage**

Confirm both `.gitignore` (repo root) and `template/gitignore` contain
`memory/*.db` patterns. If the conversation context plan added
`memory/conversation.db` as a specific entry, it's covered by the
wildcard — no conflict.

- [ ] **Step 2: Verify deploy config**

Read `deploy/azure-functions/host.config.mjs` and confirm it has
`conversationContext` (not `workingContext`) in its memory block.
This should have been done by the conversation context plan's Task 5.

---

Plan complete. Six implementation tasks, one verification task. All changes
are documentation and templates — no runtime code changes. The conversation
context plan must land first.
