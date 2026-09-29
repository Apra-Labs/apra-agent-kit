// tests/host-checkpoint-durable.test.mjs
//
// On Azure the orchestration output becomes a pointer.
//
// Durable caps an output at 16 KB. #63 had to ship a `pause_too_large` failure
// because the state travelled in that output and a long run would not fit.
// With the state in the memory store the output carries a key, so the cap
// stops mattering — and that guard becomes an assertion rather than a path.

import { test } from 'node:test';
import assert from 'node:assert/strict';

const { buildOrchestrator } = await import('../comm/azure-functions/orchestrator.mjs');
const { mapDurableStatus } = await import('../host/jobs/durable.mjs');

const aBatch = () => ({
  batchId: 'inp-a3f19c284d61',
  jobId: 'job-1',
  askedBy: 'guardrail',
  questions: [{ fieldId: 'proceed', kind: 'approval', prompt: 'Book the flight?', required: true }],
  askedAt: '2026-09-30T09:00:00.000Z',
  staleAfter: '2026-10-01T09:00:00.000Z',
  expiresAt: '2026-10-07T09:00:00.000Z',
});

function runOrchestrator(activityOutput) {
  const customStatuses = [];
  const ctx = {
    df: {
      instanceId: 'job-1',
      currentUtcDateTime: new Date('2026-09-30T09:00:00Z'),
      getInput: () => ({ task: { goal: 'g' } }),
      setCustomStatus: (s) => customStatuses.push(structuredClone(s)),
      callActivity: () => ({ __activity: true }),
    },
  };
  const gen = buildOrchestrator()(ctx);
  gen.next();
  const step = gen.next(activityOutput);
  return { output: step.value, customStatuses, done: step.done };
}

const paused = (over = {}) => ({
  status: 'paused',
  batchId: aBatch().batchId,
  batch: aBatch(),
  checkpointKey: 'cp-job-1',
  ...over,
});

// ---------------------------------------------------------------------------
// The output
// ---------------------------------------------------------------------------

test('a paused output carries a pointer, not state', () => {
  const { output, done } = runOrchestrator(paused());
  assert.equal(done, true, 'the orchestration still completes rather than waiting');
  assert.equal(output.checkpointKey, 'cp-job-1');
  assert.equal('snapshot' in output, false, 'the state is in the memory store now');
  assert.equal('history' in output, false);
});

test('a pause can no longer be too large to fit', () => {
  // The 16 KB cap applied to the state. It now applies to a pointer, so the
  // failure this guard existed for is unreachable in practice.
  const { output } = runOrchestrator(paused());
  assert.equal(output.status, 'paused');
  assert.notEqual(output.error?.code, 'pause_too_large');
});

test('the guard survives as an assertion, in case state comes back', () => {
  // If this ever fires, something has started putting state in the output
  // again — which is worth failing loudly rather than truncating silently.
  const { output } = runOrchestrator(paused({ filler: 'x'.repeat(20_000) }));
  assert.equal(output.status, 'failed');
  assert.equal(output.error.code, 'pause_too_large');
  assert.match(output.error.message, /pointer, not state/);
});

test('customStatus still carries the small marker', () => {
  const { customStatuses } = runOrchestrator(paused());
  const last = customStatuses.at(-1);
  assert.equal(last.status, 'waiting_input');
  assert.equal(last.pendingInput.batchId, aBatch().batchId);
  assert.equal('snapshot' in last, false);
});

test('a normal settle is unchanged', () => {
  const { output } = runOrchestrator({ status: 'completed', result: 'done' });
  assert.equal(output.status, 'completed');
  assert.equal(output.result, 'done');
});

// ---------------------------------------------------------------------------
// Reading it back
// ---------------------------------------------------------------------------

test('a paused instance exposes its checkpoint key, not its state', () => {
  const record = mapDurableStatus({
    instanceId: 'job-1',
    runtimeStatus: 'Completed',
    output: paused(),
    customStatus: { status: 'waiting_input' },
    input: { record: { id: 'job-1', task: { goal: 'g' } } },
  });

  assert.equal(record.status, 'waiting_input');
  assert.equal(record.checkpointKey, 'cp-job-1');
  assert.equal(record.pendingBatchId, aBatch().batchId);
  assert.equal(record.pendingInput.batchId, aBatch().batchId, 'the batch is still there for the UI');
  assert.equal(record.snapshot, undefined, 'but not the state');
});

test('an ordinary Completed instance is untouched', () => {
  const record = mapDurableStatus({
    instanceId: 'job-1', runtimeStatus: 'Completed',
    output: { status: 'completed', result: 'done', history: [] },
    customStatus: {}, input: { record: { id: 'job-1' } },
  });
  assert.equal(record.status, 'completed');
  assert.equal(record.result, 'done');
  assert.equal(record.checkpointKey, undefined);
});
