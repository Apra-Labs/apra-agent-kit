// tests/host-checkpoint-record.test.mjs
//
// The one record that replaces memory's run-state and human input's snapshot.
//
// Three facts lived in both of those: the plan, the step cursor, and the
// observations. Two writers, two triggers, two homes, and nothing saying which
// wins. This is the shape that ends that.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { checkpointKey, CHECKPOINT_VERSION, createCheckpointRecord, validateCheckpoint, scrub } =
  await import('../host/checkpoint/record.mjs');

// ---------------------------------------------------------------------------
// The key
// ---------------------------------------------------------------------------

test('key: an id wins, because two jobs may share a goal', () => {
  assert.equal(checkpointKey({ id: 'job-1', goal: 'plan a trip' }), 'cp-job-1');
  assert.notEqual(
    checkpointKey({ id: 'job-1', goal: 'plan a trip' }),
    checkpointKey({ id: 'job-2', goal: 'plan a trip' }),
  );
});

test('key: a task with no id is refused rather than sharing a row', () => {
  // The retired run-state keyed on `task.id ?? task.goal`. Two concurrent runs
  // of the same goal then read and wrote one row, each clobbering the other.
  assert.throws(() => checkpointKey({ goal: 'plan a trip' }), /requires an id/);
  assert.throws(() => checkpointKey({ id: '' }), /requires an id/);
  assert.throws(() => checkpointKey(null), /requires an id/);
});

test('key: the id is safe to use as a memory id', () => {
  assert.throws(() => checkpointKey({ id: '../escape' }), /unsafe/);
  assert.throws(() => checkpointKey({ id: 'a/b' }), /unsafe/);
});

// ---------------------------------------------------------------------------
// The record
// ---------------------------------------------------------------------------

const base = () => ({
  taskKey: 'cp-job-1', jobId: 'job-1', traceId: 'tr-1',
  task: { goal: 'g' },
  agentName: 'apra-agent-kit', agentDescription: 'a travel agent',
  strategy: 'plan-execute',
  plan: { steps: ['a', 'b'], cursor: 1 },
  observations: [{ type: 'observation', tool: 'weather', args: {}, result: { ok: true } }],
  idempotencyKeys: ['weather-{}-0'],
  conversation: [{ role: 'user', content: 'hi' }],
  recalledFacts: [{ id: 'mem-1', text: 'prefers trains' }],
  budget: { iterations: 3, elapsedMs: 1200 },
  interruptions: 1,
  identity: { personId: 'p-1' },
  pendingBatchId: 'inp-1',
  workspace: { workerId: 'WORKER-1' },
});

test('record: carries the three fields the snapshot was missing', () => {
  // Resuming under a renamed agent or a different strategy changes behaviour
  // with no trace. These are as load-bearing as the plan cursor.
  const r = createCheckpointRecord(base());
  assert.equal(r.agentName, 'apra-agent-kit');
  assert.equal(r.agentDescription, 'a travel agent');
  assert.equal(r.strategy, 'plan-execute');
});

test('record: carries what both retired records held', () => {
  const r = createCheckpointRecord(base());
  // from run-state
  assert.deepEqual(r.idempotencyKeys, ['weather-{}-0']);
  assert.equal(r.plan.cursor, 1);
  assert.equal(r.observations.length, 1);
  // from the snapshot
  assert.equal(r.pendingBatchId, 'inp-1');
  assert.equal(r.interruptions, 1);
  assert.deepEqual(r.identity, { personId: 'p-1' });
});

test('record: stamps its version and survives JSON', () => {
  const r = createCheckpointRecord(base());
  assert.equal(r.version, CHECKPOINT_VERSION);
  assert.deepEqual(validateCheckpoint(JSON.parse(JSON.stringify(r))).checkpoint, r);
});

test('record: interruptions persists, or maxInterruptions never trips', () => {
  assert.equal(createCheckpointRecord({ ...base(), interruptions: 7 }).interruptions, 7);
});

test('record: records the worker for incidents, not for resume', () => {
  const r = createCheckpointRecord(base());
  assert.deepEqual(r.workspace, { workerId: 'WORKER-1' });
});

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

test('record: no credential survives', () => {
  const r = createCheckpointRecord({
    ...base(),
    task: { goal: 'g', inputs: { apiKey: 'sk-live-1' } },
    conversation: [{ headers: { Authorization: 'Bearer abc' } }],
    observations: [{ result: { refresh_token: 'rt-1' } }],
    identity: { personId: 'p-1', accessToken: 'eyJhbGciOi', cookie: 'sid=abc' },
  });
  const json = JSON.stringify(r);
  for (const leak of ['sk-live-1', 'Bearer abc', 'rt-1', 'eyJhbGciOi', 'sid=abc']) {
    assert.equal(json.includes(leak), false, `leaked: ${leak}`);
  }
  // Identity is allow-listed, not filtered: a filter only removes the
  // credential shapes somebody thought of.
  assert.deepEqual(r.identity, { personId: 'p-1' });
});

test('record: scrub handles a cycle rather than throwing', () => {
  const a = { name: 'a' };
  a.self = a;
  assert.deepEqual(scrub(a), { name: 'a', self: null });
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

test('record: an incompatible version is refused, not coerced', () => {
  // A different build may have meant something different by the same field
  // name. Resuming on a misread cursor re-executes completed work.
  const res = validateCheckpoint({ version: 99, taskKey: 'cp-job-1' });
  assert.equal(res.ok, false);
  assert.equal(res.reason, 'incompatible_version');
  assert.deepEqual(res.detail, { found: 99, expected: CHECKPOINT_VERSION });
});

test('record: absent and unreadable are distinguishable', () => {
  assert.equal(validateCheckpoint(null).reason, 'absent');
  assert.equal(validateCheckpoint(undefined).reason, 'absent');
  assert.equal(validateCheckpoint('nope').reason, 'unreadable');
  assert.equal(validateCheckpoint([]).reason, 'unreadable');
  assert.equal(validateCheckpoint({ version: CHECKPOINT_VERSION }).reason, 'unreadable');
});
