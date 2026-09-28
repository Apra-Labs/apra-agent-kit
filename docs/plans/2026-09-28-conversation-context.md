# Conversation Context Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Repurpose the dead-weight working-context tier into a conversation-level memory that carries prior chat turns across tasks, with LLM summarization compaction and FSRS-6 decay.

**Architecture:** Client sends a `sessionId` with each chat message. Server maintains conversation turns in a dedicated SQLite table. Before each task, turns are loaded, decayed, optionally compacted via LLM summarization, and injected into the system prompt. After the task, the goal+answer pair is recorded as a new turn. The old working-context module is removed — both strategies fall back to their local `observations[]` array for intra-task history.

**Tech Stack:** Node.js (ESM), `node:sqlite` (`DatabaseSync`), `node:crypto`, `node:test` + `assert/strict`

**Spec:** `docs/specs/2026-09-28-conversation-context-spec.md`

## Global Constraints

- Node.js ESM modules only — no CommonJS, no TypeScript.
- `node:sqlite` (`DatabaseSync`) — same as the existing memory store. No external SQLite packages.
- `node:test` + `assert/strict` — same test framework as every other test file.
- All new config keys go under `modules.memory.conversationContext` in `host.config.mjs`.
- Existing behavior when conversation context is disabled must be unchanged — all new code paths are guarded by `memory?.conversationContext` checks.
- Answer text stored in conversation turns is truncated to 500 characters max.

## Review Focus

1. **Empty/null sessionId** — when the client doesn't send a `sessionId` (e.g., API call, not chat), the entire conversation context pipeline must be skipped silently, not throw.
2. **Concurrent sessions** — two browser tabs create two `sessionId`s; turns from one must never leak into the other's context.
3. **LLM summarization returns garbage** — if the summarization response is empty, malformed, or an error object, the fallback to sliding-window must fire and the task must still run.
4. **Store open/close ordering** — conversation store must open before any task runs and close cleanly on host shutdown, even if the store was never used.
5. **Working-context removal regressions** — after removing working-context, the 7 existing tests that reference it (`host-memory-working-context.test.mjs`, `host-memory-module.test.mjs`, `host-memory-integration.test.mjs`, `host-run-loop.test.mjs`) must be updated or removed without breaking the remaining 40+ test files.

---

### Task 1: Conversation Store Interface + SQLite Adapter

**Files:**
- Create: `host/memory/conversation-store/interface.mjs`
- Create: `host/memory/conversation-store/sqlite.mjs`
- Create: `host/memory/conversation-store/cosmos.mjs`
- Test: `tests/host-memory-conversation-store.test.mjs`
- Test: `tests/helpers/conversation-store-contract.mjs`

**Interfaces:**
- Consumes: `node:sqlite` `DatabaseSync`, `node:fs` `mkdirSync`, `node:path`
- Produces:
  - `CONVERSATION_STORE_METHODS` — array of required method names
  - `assertConversationStore(store)` — validator, throws if methods missing
  - `createConversationSqliteStore({ dbPath }) → store` — SQLite adapter implementing the contract
  - `createConversationCosmosStore({ endpoint, key, database, container }) → store` — Cosmos adapter (same contract, lazy-loaded)

- [ ] **Step 1: Create the store interface**

```js
// host/memory/conversation-store/interface.mjs
export const CONVERSATION_STORE_METHODS = [
  'open',
  'close',
  'append',
  'get',
  'update',
  'listSession',
  'purgeSessions',
];

export function assertConversationStore(store) {
  const missing = CONVERSATION_STORE_METHODS.filter(m => typeof store?.[m] !== 'function');
  if (missing.length) throw new Error(`conversation store missing: ${missing.join(', ')}`);
  return store;
}
```

- [ ] **Step 2: Write the contract test helper**

Shared test suite that any adapter must pass — same pattern as `tests/helpers/memory-store-contract.mjs`.

```js
// tests/helpers/conversation-store-contract.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConversationStore } from '../../host/memory/conversation-store/interface.mjs';

export function conversationStoreContractTests(createStore) {
  test('assertConversationStore validates the adapter', async () => {
    const store = await createStore();
    assert.doesNotThrow(() => assertConversationStore(store));
    await store.close();
  });

  test('append and get a turn', async () => {
    const store = await createStore();
    const turn = {
      id: 'ct-aaa', sessionId: 'ses-111', turnIndex: 0,
      goal: 'Find flights to Tokyo', answer: 'Here are 3 flights...',
      status: 'completed', createdAt: new Date().toISOString(),
      retrievalStrength: 1.0, stability: 1.0, state: 'active',
      lastPromotedAt: new Date().toISOString(), summary: null,
    };
    await store.append(turn);
    const got = await store.get('ct-aaa');
    assert.equal(got.id, 'ct-aaa');
    assert.equal(got.goal, 'Find flights to Tokyo');
    assert.equal(got.sessionId, 'ses-111');
    await store.close();
  });

  test('listSession returns turns ordered by turnIndex', async () => {
    const store = await createStore();
    const base = { sessionId: 'ses-222', status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    await store.append({ ...base, id: 'ct-b', turnIndex: 1, goal: 'second', answer: 'b' });
    await store.append({ ...base, id: 'ct-a', turnIndex: 0, goal: 'first', answer: 'a' });
    const turns = await store.listSession('ses-222');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].goal, 'first');
    assert.equal(turns[1].goal, 'second');
    await store.close();
  });

  test('listSession filters by state', async () => {
    const store = await createStore();
    const base = { sessionId: 'ses-333', status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, lastPromotedAt: null, summary: null };
    await store.append({ ...base, id: 'ct-x', turnIndex: 0, goal: 'g1', answer: 'a1', state: 'active' });
    await store.append({ ...base, id: 'ct-y', turnIndex: 1, goal: 'g2', answer: 'a2', state: 'silent' });
    const active = await store.listSession('ses-333', { states: ['active'] });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'ct-x');
    await store.close();
  });

  test('listSession respects limit', async () => {
    const store = await createStore();
    const base = { sessionId: 'ses-444', status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    for (let i = 0; i < 5; i++) {
      await store.append({ ...base, id: `ct-${i}`, turnIndex: i, goal: `g${i}`, answer: `a${i}` });
    }
    const limited = await store.listSession('ses-444', { limit: 3 });
    assert.equal(limited.length, 3);
    await store.close();
  });

  test('update patches a turn', async () => {
    const store = await createStore();
    const turn = { id: 'ct-upd', sessionId: 'ses-555', turnIndex: 0, goal: 'g', answer: null, status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    await store.append(turn);
    const updated = await store.update('ct-upd', { answer: 'done', retrievalStrength: 0.8, state: 'dormant' });
    assert.equal(updated.answer, 'done');
    assert.equal(updated.retrievalStrength, 0.8);
    assert.equal(updated.state, 'dormant');
    await store.close();
  });

  test('purgeSessions removes old sessions', async () => {
    const store = await createStore();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const base = { status: 'completed', retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    await store.append({ ...base, id: 'ct-old', sessionId: 'ses-old', turnIndex: 0, goal: 'old', answer: 'old', createdAt: old });
    await store.append({ ...base, id: 'ct-new', sessionId: 'ses-new', turnIndex: 0, goal: 'new', answer: 'new', createdAt: recent });
    const purged = await store.purgeSessions({ olderThanDays: 7 });
    assert.equal(purged, 1);
    const remaining = await store.get('ct-new');
    assert.ok(remaining);
    const gone = await store.get('ct-old');
    assert.equal(gone, null);
    await store.close();
  });

  test('get returns null for missing id', async () => {
    const store = await createStore();
    const got = await store.get('ct-missing');
    assert.equal(got, null);
    await store.close();
  });

  test('listSession returns empty for unknown session', async () => {
    const store = await createStore();
    const turns = await store.listSession('ses-unknown');
    assert.deepEqual(turns, []);
    await store.close();
  });
}
```

- [ ] **Step 3: Write the SQLite-specific test file that runs the contract**

```js
// tests/host-memory-conversation-store.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationSqliteStore } from '../host/memory/conversation-store/sqlite.mjs';
import { conversationStoreContractTests } from './helpers/conversation-store-contract.mjs';

conversationStoreContractTests(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-store-'));
  const dbPath = path.join(dir, 'conversation.db');
  const store = createConversationSqliteStore({ dbPath });
  await store.open();
  return store;
});
```

- [ ] **Step 4: Run tests to verify they fail**

Run: `node --test tests/host-memory-conversation-store.test.mjs`
Expected: FAIL — module `../host/memory/conversation-store/sqlite.mjs` not found.

- [ ] **Step 5: Implement the SQLite adapter**

```js
// host/memory/conversation-store/sqlite.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
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
`;

function toRow(turn) {
  return {
    id: turn.id, session_id: turn.sessionId, turn_index: turn.turnIndex,
    goal: turn.goal, answer: turn.answer ?? null, status: turn.status,
    created_at: turn.createdAt, retrieval_strength: turn.retrievalStrength,
    stability: turn.stability, state: turn.state,
    last_promoted_at: turn.lastPromotedAt ?? null, summary: turn.summary ?? null,
  };
}

function fromRow(row) {
  return {
    id: row.id, sessionId: row.session_id, turnIndex: row.turn_index,
    goal: row.goal, answer: row.answer, status: row.status,
    createdAt: row.created_at, retrievalStrength: row.retrieval_strength,
    stability: row.stability, state: row.state,
    lastPromotedAt: row.last_promoted_at, summary: row.summary,
  };
}

export function createConversationSqliteStore({ dbPath }) {
  if (!dbPath) throw new Error('createConversationSqliteStore requires dbPath');
  let db = null;

  const ensureOpen = () => { if (!db) throw new Error('conversation store is not open'); };

  return {
    async open() {
      if (db) return;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);
    },

    async close() {
      if (!db) return;
      db.close();
      db = null;
    },

    async append(turn) {
      ensureOpen();
      const r = toRow(turn);
      db.prepare(
        `INSERT INTO conversation_turns (id, session_id, turn_index, goal, answer, status, created_at, retrieval_strength, stability, state, last_promoted_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(r.id, r.session_id, r.turn_index, r.goal, r.answer, r.status, r.created_at, r.retrieval_strength, r.stability, r.state, r.last_promoted_at, r.summary);
    },

    async get(id) {
      ensureOpen();
      const row = db.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(id);
      return row ? fromRow(row) : null;
    },

    async update(id, patch) {
      ensureOpen();
      const row = db.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(id);
      if (!row) throw new Error(`conversation turn ${id} not found`);
      const existing = fromRow(row);
      const next = { ...existing, ...patch };
      const nr = toRow(next);
      db.prepare(
        `UPDATE conversation_turns SET goal=?, answer=?, status=?, retrieval_strength=?, stability=?, state=?, last_promoted_at=?, summary=? WHERE id=?`
      ).run(nr.goal, nr.answer, nr.status, nr.retrieval_strength, nr.stability, nr.state, nr.last_promoted_at, nr.summary, id);
      return next;
    },

    async listSession(sessionId, { states, limit } = {}) {
      ensureOpen();
      let sql = 'SELECT * FROM conversation_turns WHERE session_id = ?';
      const params = [sessionId];
      if (states?.length) {
        sql += ` AND state IN (${states.map(() => '?').join(',')})`;
        params.push(...states);
      }
      sql += ' ORDER BY turn_index ASC';
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }
      return db.prepare(sql).all(...params).map(fromRow);
    },

    async purgeSessions({ olderThanDays } = {}) {
      ensureOpen();
      if (!olderThanDays) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const { changes } = db.prepare('DELETE FROM conversation_turns WHERE created_at < ?').run(cutoff);
      return Number(changes);
    },
  };
}
```

- [ ] **Step 6: Implement the Cosmos adapter**

```js
// host/memory/conversation-store/cosmos.mjs
export function createConversationCosmosStore({ endpoint, key, database, container: containerName }) {
  if (!endpoint || !key) throw new Error('createConversationCosmosStore requires endpoint and key');
  let client = null;
  let container = null;

  function toDoc(turn) {
    return { id: turn.id, partitionKey: turn.sessionId, ...turn };
  }

  function fromDoc(doc) {
    const { _rid, _self, _etag, _attachments, _ts, partitionKey, ...turn } = doc;
    return turn;
  }

  return {
    async open() {
      const { CosmosClient } = await import('@azure/cosmos');
      client = new CosmosClient({ endpoint, key });
      const { database: db } = await client.databases.createIfNotExists({ id: database });
      const { container: cont } = await db.containers.createIfNotExists({
        id: containerName,
        partitionKey: { paths: ['/partitionKey'] },
      });
      container = cont;
    },

    async close() { client = null; container = null; },

    async append(turn) {
      await container.items.create(toDoc(turn));
    },

    async get(id) {
      const sql = 'SELECT * FROM c WHERE c.id = @id';
      const { resources } = await container.items.query({ query: sql, parameters: [{ name: '@id', value: id }] }).fetchAll();
      return resources.length ? fromDoc(resources[0]) : null;
    },

    async update(id, patch) {
      const existing = await this.get(id);
      if (!existing) throw new Error(`conversation turn ${id} not found`);
      const next = { ...existing, ...patch };
      await container.item(id, existing.sessionId).replace(toDoc(next));
      return next;
    },

    async listSession(sessionId, { states, limit } = {}) {
      const conditions = ['c.sessionId = @sid'];
      const params = [{ name: '@sid', value: sessionId }];
      if (states?.length) {
        conditions.push(`c.state IN (${states.map((_, i) => `@s${i}`).join(',')})`);
        states.forEach((s, i) => params.push({ name: `@s${i}`, value: s }));
      }
      let sql = `SELECT * FROM c WHERE ${conditions.join(' AND ')} ORDER BY c.turnIndex ASC`;
      const { resources } = await container.items.query({ query: sql, parameters: params }).fetchAll();
      let results = resources.map(fromDoc);
      if (limit) results = results.slice(0, limit);
      return results;
    },

    async purgeSessions({ olderThanDays } = {}) {
      if (!olderThanDays) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const sql = 'SELECT * FROM c WHERE c.createdAt < @cutoff';
      const { resources } = await container.items.query({ query: sql, parameters: [{ name: '@cutoff', value: cutoff }] }).fetchAll();
      for (const doc of resources) {
        await container.item(doc.id, doc.sessionId).delete();
      }
      return resources.length;
    },
  };
}
```

- [ ] **Step 7: Run tests to verify they pass**

Run: `node --test tests/host-memory-conversation-store.test.mjs`
Expected: All 9 tests PASS (contract suite via SQLite adapter).

- [ ] **Step 8: Commit**

```bash
git add host/memory/conversation-store/interface.mjs host/memory/conversation-store/sqlite.mjs host/memory/conversation-store/cosmos.mjs tests/host-memory-conversation-store.test.mjs tests/helpers/conversation-store-contract.mjs
git commit -m "feat(memory): add conversation store adapter interface with SQLite and Cosmos implementations"
```

---

### Task 2: Conversation Context Module (`conversation-context.mjs`)

**Files:**
- Create: `host/memory/conversation-context.mjs`
- Test: `tests/host-memory-conversation-context.test.mjs`

**Interfaces:**
- Consumes: any adapter implementing `CONVERSATION_STORE_METHODS` (Task 1), `createFsrs6Engine` from `host/memory/decay/fsrs6.mjs`, `randomUUID` from `node:crypto`
- Produces: `createConversationContext({ store, engine, fleetApi, maxRecentTurns, maxTotalTurns, compactionStrategy, answerMaxChars, logger }) → { open(), close(), forPrompt(sessionId), recordTurn(sessionId, { goal, answer, status }), promoteTurn(sessionId, turnId) }`

- [ ] **Step 1: Write failing tests**

```js
// tests/host-memory-conversation-context.test.mjs
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationStore } from '../host/memory/conversation-store.mjs';
import { createConversationContext } from '../host/memory/conversation-context.mjs';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';

let store, ctx, dbPath;
const engine = createFsrs6Engine();
const noopApi = { executePrompt: async () => 'Summary of conversation.' };
const silentLogger = { info() {}, warn() {}, error() {} };

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-ctx-'));
  dbPath = path.join(dir, 'conversation.db');
  store = createConversationStore({ dbPath });
  await store.open();
});

afterEach(async () => {
  if (ctx?.close) await ctx.close();
  await store.close();
});

test('recordTurn stores a turn and forPrompt retrieves it', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, logger: silentLogger });
  await ctx.recordTurn('ses-1', { goal: 'Hello', answer: 'Hi there', status: 'completed' });
  const prompt = await ctx.forPrompt('ses-1');
  assert.ok(prompt.length >= 1);
  assert.ok(prompt.some(t => t.goal === 'Hello'));
});

test('forPrompt returns empty array for unknown session', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, logger: silentLogger });
  const prompt = await ctx.forPrompt('ses-unknown');
  assert.deepEqual(prompt, []);
});

test('answer is truncated to answerMaxChars', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, answerMaxChars: 20, logger: silentLogger });
  await ctx.recordTurn('ses-2', { goal: 'Q', answer: 'A'.repeat(100), status: 'completed' });
  const turns = await store.listSession('ses-2');
  assert.ok(turns[0].answer.length <= 20);
});

test('maxTotalTurns drops oldest when exceeded', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, maxTotalTurns: 3, logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-3', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const all = await store.listSession('ses-3');
  assert.ok(all.length <= 3);
});

test('compaction summarises older turns', async () => {
  let summaryCalled = false;
  const fakeApi = {
    executePrompt: async () => { summaryCalled = true; return 'Conversation summary.'; },
  };
  ctx = createConversationContext({ store, engine, fleetApi: fakeApi, maxRecentTurns: 2, logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-4', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const prompt = await ctx.forPrompt('ses-4');
  assert.ok(summaryCalled);
  assert.ok(prompt.some(t => t.role === 'summary'));
});

test('compaction falls back to sliding-window when summarisation fails', async () => {
  const failApi = { executePrompt: async () => { throw new Error('LLM down'); } };
  ctx = createConversationContext({ store, engine, fleetApi: failApi, maxRecentTurns: 2, logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-5', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const prompt = await ctx.forPrompt('ses-5');
  assert.ok(prompt.length <= 2);
  assert.ok(!prompt.some(t => t.role === 'summary'));
});

test('sliding-window strategy skips summarisation', async () => {
  let called = false;
  const spyApi = { executePrompt: async () => { called = true; return 'Summary.'; } };
  ctx = createConversationContext({ store, engine, fleetApi: spyApi, maxRecentTurns: 2, compactionStrategy: 'sliding-window', logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-6', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const prompt = await ctx.forPrompt('ses-6');
  assert.equal(called, false);
  assert.ok(prompt.length <= 2);
});

test('decay transitions old turns to dormant/silent', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, maxRecentTurns: 10, logger: silentLogger });
  await ctx.recordTurn('ses-7', { goal: 'old', answer: 'old-a', status: 'completed' });
  // Manually age the turn's lastPromotedAt to 90 days ago and set stability low
  const turns = await store.listSession('ses-7');
  const aged = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await store.update(turns[0].id, { lastPromotedAt: aged, stability: 0.1, createdAt: aged });
  const prompt = await ctx.forPrompt('ses-7');
  // After decay, the turn should be dormant or silent and may be excluded
  const updated = await store.get(turns[0].id);
  assert.notEqual(updated.state, 'active');
});

test('promoteTurn boosts retrievalStrength', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, logger: silentLogger });
  await ctx.recordTurn('ses-8', { goal: 'q', answer: 'a', status: 'completed' });
  const turns = await store.listSession('ses-8');
  // Age it slightly so promote has an effect
  const aged = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await store.update(turns[0].id, { lastPromotedAt: aged });
  await ctx.promoteTurn('ses-8', turns[0].id);
  const updated = await store.get(turns[0].id);
  assert.equal(updated.state, 'active');
  assert.ok(updated.lastPromotedAt > aged);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-memory-conversation-context.test.mjs`
Expected: FAIL — module `../host/memory/conversation-context.mjs` not found.

- [ ] **Step 3: Implement conversation context module**

```js
// host/memory/conversation-context.mjs
import { randomUUID } from 'node:crypto';

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max);
}

export function createConversationContext({
  store,
  engine,
  fleetApi,
  maxRecentTurns = 6,
  maxTotalTurns = 20,
  compactionStrategy = 'summarise',
  answerMaxChars = 500,
  events = null,
  logger = console,
} = {}) {
  async function summarise(turns) {
    const text = turns.map(t => `User: ${t.goal}\nAgent: ${t.answer ?? '(no answer)'}`).join('\n\n');
    const prompt = `Summarise the following conversation history into a concise paragraph. Preserve key decisions, requests, and results. Do not add new information.\n\n${text}`;
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const summary = typeof response === 'string' ? response : (response?.content ?? []).map(p => p.text ?? '').join('\n');
    return summary;
  }

  async function runDecay(turns) {
    const now = new Date();
    for (const turn of turns) {
      const r = engine.computeRetrievability(turn, now);
      const newState = engine.computeState(r);
      if (newState !== turn.state || Math.abs(r - turn.retrievalStrength) > 0.01) {
        await store.update(turn.id, { retrievalStrength: r, state: newState });
        turn.retrievalStrength = r;
        turn.state = newState;
      }
    }
  }

  return {
    mode: 'store',
    maxRecentTurns,

    async open() { await store.open(); },
    async close() { await store.close(); },

    async forPrompt(sessionId) {
      if (!sessionId) return [];
      const allTurns = await store.listSession(sessionId, { states: ['active', 'dormant'] });
      if (allTurns.length === 0) return [];

      await runDecay(allTurns);

      const visible = allTurns.filter(t => t.state === 'active' || t.state === 'dormant');
      if (visible.length === 0) return [];

      events?.emit('memory:conversation:recall', { sessionId, turnCount: visible.length });

      if (visible.length <= maxRecentTurns) {
        return visible.map(t => ({ role: 'turn', goal: t.goal, answer: t.answer }));
      }

      const older = visible.slice(0, visible.length - maxRecentTurns);
      const recent = visible.slice(-maxRecentTurns);

      if (compactionStrategy === 'summarise') {
        try {
          const summaryText = await summarise(older);
          events?.emit('memory:conversation:compact', { sessionId, strategy: 'summarise', survivingTurns: recent.length });
          return [
            { role: 'summary', text: summaryText },
            ...recent.map(t => ({ role: 'turn', goal: t.goal, answer: t.answer })),
          ];
        } catch (err) {
          logger.warn?.(`[memory/conversation] summarise failed, falling back to sliding-window: ${err?.message ?? err}`);
        }
      }

      events?.emit('memory:conversation:compact', { sessionId, strategy: 'sliding-window', survivingTurns: recent.length });
      return recent.map(t => ({ role: 'turn', goal: t.goal, answer: t.answer }));
    },

    async recordTurn(sessionId, { goal, answer, status }) {
      if (!sessionId) return null;
      const existing = await store.listSession(sessionId);
      const turnIndex = existing.length;

      if (maxTotalTurns && existing.length >= maxTotalTurns) {
        const sorted = [...existing].sort((a, b) => a.retrievalStrength - b.retrievalStrength);
        const toRemove = sorted.slice(0, existing.length - maxTotalTurns + 1);
        for (const old of toRemove) {
          await store.update(old.id, { state: 'unavailable' });
        }
      }

      const turn = {
        id: `ct-${randomUUID().slice(0, 12)}`,
        sessionId,
        turnIndex,
        goal,
        answer: truncate(answer, answerMaxChars),
        status: status ?? 'completed',
        createdAt: new Date().toISOString(),
        retrievalStrength: 1.0,
        stability: 1.0,
        state: 'active',
        lastPromotedAt: new Date().toISOString(),
        summary: null,
      };
      await store.append(turn);
      events?.emit('memory:conversation:store', { sessionId, turnId: turn.id });
      return turn;
    },

    async promoteTurn(sessionId, turnId) {
      const turn = await store.get(turnId);
      if (!turn || turn.sessionId !== sessionId) return null;
      const patch = engine.processReview(turn, 3);
      return store.update(turnId, patch);
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-memory-conversation-context.test.mjs`
Expected: All 9 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add host/memory/conversation-context.mjs tests/host-memory-conversation-context.test.mjs
git commit -m "feat(memory): add conversation context module with compaction and decay"
```

---

### Task 3: Remove Working Context + Wire Conversation Context into Memory Module

**Files:**
- Delete: `host/memory/working-context.mjs`
- Delete: `tests/host-memory-working-context.test.mjs`
- Modify: `host/memory/index.mjs:1-130`
- Modify: `host/run-loop.mjs:36-43`
- Modify: `host/strategies/plan-execute.mjs:44-61`
- Modify: `host/strategies/open-ended.mjs:30-48`
- Modify: `host/config.mjs:129-133`
- Modify: `tests/host-memory-module.test.mjs` (update working-context references)
- Modify: `tests/host-memory-integration.test.mjs` (update working-context references)
- Modify: `tests/host-run-loop.test.mjs` (update working-context references)
- Test: run existing test suite

**Interfaces:**
- Consumes: `createConversationStore` (Task 1), `createConversationContext` (Task 2), `createFsrs6Engine` from `host/memory/decay/fsrs6.mjs`
- Produces: updated `createMemoryModule` that exposes `conversationContext` instead of `workingContext` / `createRunWorkingContext`

- [ ] **Step 1: Read the files to modify**

Read: `host/memory/index.mjs`, `host/run-loop.mjs`, `host/strategies/plan-execute.mjs`, `host/strategies/open-ended.mjs`, `host/config.mjs`

- [ ] **Step 2: Update `host/memory/index.mjs`**

Remove the `createWorkingContext` import and all `workingContext` / `createRunWorkingContext` logic. Add conversation store + context imports. Add a `resolveConversationStore` function following the same pattern as the existing `resolveStore`. Add `conversationContext` to the returned module.

Changes:
- Remove: `import { createWorkingContext } from './working-context.mjs';`
- Add: `import { assertConversationStore } from './conversation-store/interface.mjs';`
- Add: `import { createConversationSqliteStore } from './conversation-store/sqlite.mjs';`
- Add: `import { createConversationContext } from './conversation-context.mjs';`
- Remove: the `wcOptions` / `wc` block (lines ~48-51)
- Add: `resolveConversationStore` function + conversation context initialization
- Remove: `workingContext: wc` and `createRunWorkingContext()` from return object
- Add: `conversationContext: cc` to return object
- Update `open()`: add `cc?.open()`
- Update `close()`: add `cc?.close()`

```js
// Add resolveConversationStore alongside existing resolveStore:
async function resolveConversationStore(config) {
  if (typeof config.store === 'function') {
    return assertConversationStore(config.store(config));
  }
  switch (config.store) {
    case 'sqlite': return createConversationSqliteStore({ dbPath: config.dbPath ?? './memory/conversation.db' });
    case 'cosmos': {
      const { createConversationCosmosStore } = await import('./conversation-store/cosmos.mjs');
      return createConversationCosmosStore(config.cosmos ?? {});
    }
    default: return createConversationSqliteStore({ dbPath: config.dbPath ?? './memory/conversation.db' });
  }
}

// In createMemoryModule, replace the workingContext block with:
const ccConfig = memoryConfig?.conversationContext
  ? interpolateConfigStrings(memoryConfig.conversationContext, process.env)
  : null;
let cc = null;
if (ccConfig?.enabled) {
  const ccMode = ccConfig.mode ?? 'store';
  if (ccMode === 'store') {
    const ccStore = await resolveConversationStore(ccConfig);
    cc = createConversationContext({
      store: ccStore,
      engine,  // reuse the FSRS-6 engine (see note below)
      fleetApi,
      maxRecentTurns: ccConfig.maxRecentTurns ?? 6,
      maxTotalTurns: ccConfig.maxTotalTurns ?? 20,
      compactionStrategy: ccConfig.compactionStrategy ?? 'summarise',
      answerMaxChars: ccConfig.answerMaxChars ?? 500,
      events,
      logger,
    });
  } else {
    // Passthrough mode — no store, no decay, just expose mode + config
    cc = {
      mode: 'passthrough',
      maxRecentTurns: ccConfig.maxRecentTurns ?? 10,
      async open() {},
      async close() {},
    };
  }
}
```

Note: the FSRS-6 engine is currently created inside the `createLongTermMemory` call. To share it, extract engine creation to the top of `createMemoryModule` so both long-term and conversation context can reuse it.

- [ ] **Step 3: Update `host/run-loop.mjs`**

Remove the `createRunWorkingContext` call and the `runMemory` construction that replaces `workingContext`. The memory object is passed through as-is now — conversation context is handled in `tasks.mjs`, not in the run loop.

Replace lines 36-43:
```js
// Before (remove):
const runMemory = memory
  ? {
      ...memory,
      workingContext: typeof memory.createRunWorkingContext === 'function'
        ? (memory.createRunWorkingContext() ?? null)
        : (memory.workingContext ?? null),
    }
  : memory;

// After (replace with):
const runMemory = memory;
```

Then in `strategyOpts`, `memory: runMemory` stays the same (it's just `memory` now).

- [ ] **Step 4: Update both strategies**

In `host/strategies/plan-execute.mjs`, remove the `remember()` function's working-context branch and the `historyForPrompt()` function's working-context branch. Both now just use the local `observations` array.

Replace `remember()` (lines 44-52):
```js
function remember(observation) {
  observations.push(observation);
}
```

Replace `historyForPrompt()` (lines 54-62):
```js
function historyForPrompt() {
  return observations;
}
```

Note: `historyForPrompt` no longer needs to be `async` since it doesn't call `forPrompt()`. Update all `await historyForPrompt()` calls to just `historyForPrompt()` (lines 163, 192, 254, 293, 313, 333, 362).

Make the same changes in `host/strategies/open-ended.mjs`:

Replace `remember()` (lines 30-37):
```js
function remember(observation) {
  observations.push(observation);
}
```

Replace `historyForPrompt()` (lines 40-48):
```js
function historyForPrompt() {
  return observations;
}
```

Update `await historyForPrompt()` to `historyForPrompt()` (line 64).

- [ ] **Step 5: Update `host/config.mjs`**

Remove the `workingContext` warning (lines 131-132):
```js
// Remove:
if (mem.workingContext?.enabled && !runLoopEnabled) {
  console.warn('[host/config] memory.workingContext enabled but runLoop disabled — no turn history to compact');
}
```

Add a conversation context warning:
```js
if (mem.conversationContext?.enabled && !modules.chat?.enabled) {
  console.warn('[host/config] memory.conversationContext enabled but chat disabled — no conversation to track');
}
```

- [ ] **Step 6: Delete old files**

Delete: `host/memory/working-context.mjs`
Delete: `tests/host-memory-working-context.test.mjs`

- [ ] **Step 7: Update affected test files**

Read and update each test file that references `workingContext`:

**`tests/host-memory-module.test.mjs`:** Replace any `createRunWorkingContext` / `workingContext` assertions with `conversationContext` equivalents or remove them.

**`tests/host-memory-integration.test.mjs`:** Replace `workingContext: { append() {}, async forPrompt() { return []; } }` stubs in the test fixtures with `conversationContext: null` (since conversation context is handled in `tasks.mjs`, not in the strategies).

**`tests/host-run-loop.test.mjs`:** Remove `workingContext` from the memory fixture. The `forPrompt` stub is no longer needed since strategies use `observations` directly.

- [ ] **Step 8: Run the full test suite**

Run: `node --test tests/`
Expected: All tests PASS. No regressions from working-context removal.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor(memory): remove working-context, wire conversation context into memory module"
```

---

### Task 4: Wire Conversation Context into Task Pipeline and Prompts

**Files:**
- Modify: `host/tasks.mjs:148-317`
- Modify: `host/prompts/system.mjs:1-77`
- Modify: `host/chat/app.mjs:581-622`
- Modify: `host/routes.mjs:40-50`
- Modify: `host.config.mjs:83-96`
- Test: `tests/host-conversation-pipeline.test.mjs`

**Interfaces:**
- Consumes: `createConversationContext` (from memory module), `buildSystemPrompt` (from prompts), task body `{ goal, sessionId?, conversation? }`
- Produces: Updated `executeHostedTask` that loads conversation context (store mode via `sessionId`) or uses caller-supplied history (passthrough mode via `conversation[]`) and records the turn after completion. Updated `buildSystemPrompt` that accepts and formats `conversation`. Updated `doSend()` that sends `sessionId` (store mode) or `conversation[]` (passthrough mode) based on config.

- [ ] **Step 1: Write failing integration test**

```js
// tests/host-conversation-pipeline.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../host/prompts/system.mjs';

test('buildSystemPrompt includes conversation history when provided', () => {
  const conversation = [
    { role: 'turn', goal: 'Find flights to Tokyo', answer: 'Found 3 flights...' },
    { role: 'turn', goal: 'Book the cheapest one', answer: 'Booked flight JAL123...' },
  ];
  const prompt = buildSystemPrompt({ agentName: 'test', conversation });
  assert.ok(prompt.includes('Conversation History'));
  assert.ok(prompt.includes('Find flights to Tokyo'));
  assert.ok(prompt.includes('Found 3 flights'));
  assert.ok(prompt.includes('Book the cheapest one'));
});

test('buildSystemPrompt includes summary when present', () => {
  const conversation = [
    { role: 'summary', text: 'User asked about Tokyo flights.' },
    { role: 'turn', goal: 'Book the cheapest one', answer: 'Booked.' },
  ];
  const prompt = buildSystemPrompt({ agentName: 'test', conversation });
  assert.ok(prompt.includes('User asked about Tokyo flights.'));
  assert.ok(prompt.includes('Book the cheapest one'));
});

test('buildSystemPrompt omits conversation section when empty or missing', () => {
  const prompt1 = buildSystemPrompt({ agentName: 'test' });
  assert.ok(!prompt1.includes('Conversation History'));
  const prompt2 = buildSystemPrompt({ agentName: 'test', conversation: [] });
  assert.ok(!prompt2.includes('Conversation History'));
});

test('buildSystemPrompt places conversation after memory, before response format', () => {
  const memories = [{ kind: 'domain', text: 'fact1' }];
  const conversation = [{ role: 'turn', goal: 'q', answer: 'a' }];
  const prompt = buildSystemPrompt({ agentName: 'test', memories, conversation });
  const memIdx = prompt.indexOf('Your Memory');
  const convIdx = prompt.indexOf('Conversation History');
  const fmtIdx = prompt.indexOf('Response format');
  assert.ok(memIdx < convIdx, 'memory should come before conversation');
  assert.ok(convIdx < fmtIdx, 'conversation should come before response format');
});

test('buildSystemPrompt handles passthrough-style raw entries', () => {
  const conversation = [
    { role: 'turn', goal: 'What is X?', answer: 'X is ...' },
  ];
  const prompt = buildSystemPrompt({ agentName: 'test', conversation });
  assert.ok(prompt.includes('What is X?'));
  assert.ok(prompt.includes('X is ...'));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test tests/host-conversation-pipeline.test.mjs`
Expected: FAIL — `buildSystemPrompt` doesn't accept or format `conversation` yet.

- [ ] **Step 3: Update `host/prompts/system.mjs`**

Add `conversation` parameter to `buildSystemPrompt`. Format it as a `## Conversation History` section placed after the memory section, before the response format.

```js
export function buildSystemPrompt({ agentName, agentDescription, memories, conversation }) {
  // ... existing head + memorySection code unchanged ...

  let conversationSection = '';
  if (conversation?.length) {
    conversationSection += '\n## Conversation History\n\n';
    conversationSection += 'The user has been chatting with you. Here is the prior conversation:\n\n';
    for (const entry of conversation) {
      if (entry.role === 'summary') {
        conversationSection += `[Earlier conversation summary]: ${entry.text}\n\n`;
      } else if (entry.role === 'turn') {
        conversationSection += `User: ${entry.goal}\nAgent: ${entry.answer ?? '(no response)'}\n\n`;
      }
    }
    conversationSection += 'Use this context to understand references like "the cheapest one", "do that again", or "the place you mentioned".\n';
  }

  // ... insert conversationSection between memorySection and rest ...
  if (!memorySection && !conversationSection) return `${head}\n${rest}`;
  return head + memorySection + conversationSection + rest;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test tests/host-conversation-pipeline.test.mjs`
Expected: All 4 tests PASS.

- [ ] **Step 5: Update `host/tasks.mjs` — `executeHostedTask`**

Between memory recall and `runTask()`, load conversation context. After the task completes, record the turn. Pass `conversationHistory` through to `runTask` which passes it through to the strategy constructors via `memories`... no — pass it as a separate field so it reaches `buildSystemPrompt`.

In the run-task call at line 265-279, add `conversationHistory` to the options. The logic handles both modes:

```js
// Before runTask call — resolve conversation history from the right source:
let conversationHistory = [];
const cc = memory?.conversationContext;
const ccMode = cc?.mode ?? null;

if (ccMode === 'store' && task.sessionId) {
  try {
    conversationHistory = await cc.forPrompt(task.sessionId);
    logger.info?.(`conversation context loaded: ${conversationHistory.length} entries for session ${task.sessionId}`);
  } catch (err) {
    logger.warn?.(`conversation context load failed — continuing: ${err?.message ?? err}`);
  }
} else if (ccMode === 'passthrough' && Array.isArray(task.conversation)) {
  const max = cc.maxRecentTurns ?? 10;
  conversationHistory = task.conversation.slice(-max * 2).map(c => ({
    role: c.role === 'assistant' ? 'turn' : c.role,
    ...(c.role === 'user' ? { goal: c.text } : {}),
    ...(c.role === 'assistant' ? { answer: c.text } : {}),
  }));
  // Pair user/assistant into turn objects
  const paired = [];
  for (let i = 0; i < conversationHistory.length - 1; i += 2) {
    const u = conversationHistory[i];
    const a = conversationHistory[i + 1];
    if (u.role === 'user' && a?.role === 'turn') {
      paired.push({ role: 'turn', goal: u.goal, answer: a.answer });
    }
  }
  conversationHistory = paired.slice(-max);
  logger.info?.(`conversation passthrough: ${conversationHistory.length} turns from caller`);
} else if (Array.isArray(task.conversation) && !ccMode) {
  // Fallback: no mode configured but caller sent conversation — use raw, cap at 10
  conversationHistory = task.conversation.slice(-10);
}

// In runTask call, add conversation:
result = await runTask(fullTask, {
  // ... existing fields ...
  conversation: conversationHistory,
});

// After the run completes — record turn (store mode only):
if (ccMode === 'store' && task.sessionId && cc) {
  try {
    const answerText = typeof result.result === 'string'
      ? result.result
      : JSON.stringify(result.result ?? null);
    await cc.recordTurn(task.sessionId, {
      goal: task.goal,
      answer: answerText,
      status: result.status,
    });
  } catch (err) {
    logger.warn?.(`conversation turn record failed: ${err?.message ?? err}`);
  }
}
```

- [ ] **Step 6: Update `host/run-loop.mjs`**

Accept `conversation` in the options and pass it to both strategy constructors:

```js
// Add conversation to the destructured options:
export async function runTask(task, {
  // ... existing fields ...
  conversation,
} = {}) {
  // ... pass through to strategyOpts:
  const strategyOpts = {
    // ... existing fields ...
    conversation,
  };
```

- [ ] **Step 7: Update both strategies to pass conversation into buildSystemPrompt**

In `host/strategies/plan-execute.mjs`, add `conversation` to the destructured parameters and pass it to `buildSystemPrompt`:

```js
export function createPlanExecuteStrategy({
  // ... existing fields ...
  conversation,
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription, memories, conversation });
  // ... rest unchanged ...
}
```

Same change in `host/strategies/open-ended.mjs`:

```js
export function createOpenEndedStrategy({
  // ... existing fields ...
  conversation,
}) {
  const systemPrompt = buildSystemPrompt({ agentName, agentDescription, memories, conversation });
  // ... rest unchanged ...
}
```

- [ ] **Step 8: Update `host/chat/app.mjs` — add sessionId and passthrough support**

The client needs to support both modes. It doesn't know the server config, so it sends **both** `sessionId` and `conversation` — the server picks the one it needs based on its mode. This is safe because:
- In `store` mode, the server uses `sessionId` and ignores `conversation`.
- In `passthrough` mode, the server uses `conversation` and ignores `sessionId`.

Add near the top of the IIFE (after `var apiBase = ...`):

```js
var sessionId = (function() {
  var key = 'chat-session-id';
  var existing = null;
  try { existing = sessionStorage.getItem(key); } catch(e) {}
  if (existing) return existing;
  var id = 'ses-' + crypto.randomUUID().slice(0, 12);
  try { sessionStorage.setItem(key, id); } catch(e) {}
  return id;
})();

var conversationTurns = [];
```

Update `doSend()` — send both, and accumulate turns on completion:

```js
// In the fetch call:
body: JSON.stringify({ goal: goal, sessionId: sessionId, conversation: conversationTurns.slice(-20) })
```

In the `settled` event handler inside `subscribe()`, when `status === 'completed'`, push the turn:

```js
// After apply() for a settled+completed event:
if (event.status === 'completed' && event.result) {
  var answerText = typeof event.result === 'string' ? event.result : JSON.stringify(event.result);
  if (answerText.length > 500) answerText = answerText.slice(0, 500);
  conversationTurns.push({ role: 'user', text: current.turn.goal });
  conversationTurns.push({ role: 'assistant', text: answerText });
}
```

- [ ] **Step 9: Update `host.config.mjs`**

Replace the `workingContext` config with `conversationContext`. Use `mode` to select store vs passthrough, and `store` to select the adapter — same pattern as long-term memory.

```js
memory: {
  // Store mode (default) — server persists turns:
  conversationContext: {
    enabled: true,
    mode: 'store',                      // 'store' | 'passthrough'
    store: 'sqlite',                    // 'sqlite' | 'cosmos' | function
    dbPath: './memory/conversation.db', // sqlite only
    maxRecentTurns: 6,
    maxTotalTurns: 20,
    compactionStrategy: 'summarise',
    answerMaxChars: 500,
  },

  // OR passthrough mode — caller sends conversation[]:
  // conversationContext: {
  //   enabled: true,
  //   mode: 'passthrough',
  //   maxRecentTurns: 10,
  // },

  runState: { enabled: true, store: 'sqlite', dbPath: './memory/run-state.db' },
  longTerm: {
    // ... unchanged ...
  },
},
```

- [ ] **Step 10: Run the full test suite**

Run: `node --test tests/`
Expected: All tests PASS.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(memory): wire conversation context into task pipeline and prompts"
```

---

### Task 5: Update Azure Functions Config + Add conversation.db to .gitignore

**Files:**
- Modify: `deploy/azure-functions/host.config.mjs` (if it has a memory section)
- Modify: `.gitignore`
- Test: verify deploy config loads without error

**Interfaces:**
- Consumes: config schema from Tasks 3-4
- Produces: deployment-ready config, clean gitignore

- [ ] **Step 1: Read the Azure Functions config**

Read: `deploy/azure-functions/host.config.mjs`

- [ ] **Step 2: Update Azure Functions config**

If it has a `workingContext` section, replace with `conversationContext` matching the same structure as `host.config.mjs`.

- [ ] **Step 3: Update `.gitignore`**

Add `memory/conversation.db`, `memory/conversation.db-shm`, `memory/conversation.db-wal` entries alongside the existing memory DB patterns.

Check existing `.gitignore` first — if it already has a wildcard like `memory/*.db`, no change needed.

- [ ] **Step 4: Run config load test**

Run: `node --test tests/host-config.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "chore: update deploy config and gitignore for conversation store"
```

---

Plan complete and saved to `docs/plans/2026-09-28-conversation-context.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — A fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end. Most thorough; costs a fresh context per task and per review.
- **Native** — I implement every task myself in this session, the way this harness runs work, then one fresh reviewer on the most capable model checks the whole branch. Cheapest and fastest; no independent review until the end.

For this plan I recommend **native**, because the tasks are tightly coupled (Task 3 removes working-context while wiring in the modules from Tasks 1-2, Task 4 threads everything through the pipeline) and the interfaces are small enough to hold in context. Does the plan capture what you want, and which approach should we use?