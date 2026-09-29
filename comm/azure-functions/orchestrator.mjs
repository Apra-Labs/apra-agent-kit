// comm/azure-functions/orchestrator.mjs
// One orchestration per job. Deterministic: it only reacts to Durable-delivered
// tasks (activity completion, 'progress' events, 'cancel' events). The activity
// (activity.mjs) is the run loop; this generator only records what it is told.
//
// customStatus contract read by host/jobs/durable.mjs:
//   { status, events: [{ seq, ...JobEvent }] (ring of 50, queued/started/settled always kept),
//     progress: { iteration, message, at }, cancelRequested, startedAt, finishedAt }
import { ACTIVITY_NAME } from '../../host/jobs/durable.mjs';
import { ringEvents } from '../../host/jobs/record.mjs';

const DURABLE_PAYLOAD_MAX_CHARS = 12_000; // stay safely under the 16 KB UTF-16 limit

function truncateOutput(output) {
  const json = JSON.stringify(output);
  if (json.length <= DURABLE_PAYLOAD_MAX_CHARS) return output;
  const safe = { ...output };
  if (typeof safe.result === 'string' && safe.result.length > 2000) {
    safe.result = safe.result.slice(0, 2000) + '… [truncated]';
  }
  if (JSON.stringify(safe).length > DURABLE_PAYLOAD_MAX_CHARS) {
    safe.result = typeof safe.result === 'string'
      ? safe.result.slice(0, 500) + '… [truncated]'
      : null;
  }
  return safe;
}

export function buildOrchestrator({ ringSize = 50 } = {}) {
  return function* runTaskOrchestrator(context) {
    const df = context.df;
    const input = df.getInput();
    const jobId = df.instanceId;
    const nowIso = () => (df.currentUtcDateTime ?? new Date()).toISOString();

    let seq = 0;
    const events = [];
    const push = (e) => { seq += 1; events.push({ ...e, seq }); };
    const state = {
      status: 'queued', events, progress: { iteration: 0, message: null, at: null },
      cancelRequested: false, startedAt: null, finishedAt: null,
    };
    const publish = () => df.setCustomStatus({ ...state, events: ringEvents(events, ringSize) });

    push(input.queuedEvent ?? { type: 'queued', jobId, at: nowIso(), position: 1 });
    state.status = 'processing';
    state.startedAt = nowIso();
    push({ type: 'started', jobId, at: state.startedAt });
    publish();

    // Single yield — one activity, one dispatch. The previous for(;;) loop
    // consumed waitForExternalEvent('progress') events, but each replay shifted
    // the Durable SDK's event-ID counter, causing callActivity() to schedule a
    // NEW activity on every replay instead of matching the original. Result:
    // N progress events → N+1 activities → worker pool exhaustion.
    const output = yield df.callActivity(ACTIVITY_NAME, { ...input, jobId });

    const at = nowIso();

    // A pause ends the orchestration. It does not wait.
    //
    // `waitForExternalEvent` is the obvious alternative and it is the wrong
    // one twice over: the replay bug documented above returns the moment this
    // generator yields more than once, and an orchestration parked on an event
    // is billed and replayed for as long as the person takes. Instead the
    // orchestration *completes*, its output carries the state, and answering
    // starts a new one. See host/jobs/durable.mjs provideInput().
    if (output.status === 'paused') {
      state.status = 'waiting_input';
      state.finishedAt = null;
      // Small on purpose. customStatus has a hard size limit and is a live
      // view, never a source of truth - the state is in the output.
      state.pendingInput = {
        batchId: output.batchId,
        askedBy: output.batch?.askedBy ?? null,
        staleAfter: output.batch?.staleAfter ?? null,
        expiresAt: output.batch?.expiresAt ?? null,
      };
      push({ type: 'input_required', jobId, at, batchId: output.batchId, questions: output.batch?.questions ?? [], askedBy: output.batch?.askedBy ?? null, staleAfter: output.batch?.staleAfter ?? null, expiresAt: output.batch?.expiresAt ?? null });
      publish();
      return guardPausedOutput(output, jobId);
    }

    state.status = output.status;
    state.finishedAt = at;
    push({ type: 'settled', jobId, at, status: output.status, result: output.result ?? null, error: output.error ?? null });
    publish();
    return truncateOutput(output);
  };
}

export const runTaskOrchestrator = buildOrchestrator();

/**
 * A paused output is a pointer now, so it cannot realistically exceed the
 * 16 KB Durable cap.
 *
 * This stays as an assertion rather than a path: if it ever fires, something
 * has started putting state back in the output, and failing loudly beats
 * truncating a pointer into nonsense.
 */
function guardPausedOutput(output, jobId) {
  const json = JSON.stringify(output);
  if (json.length <= DURABLE_PAYLOAD_MAX_CHARS) return output;

  return {
    status: 'failed',
    result: null,
    error: {
      code: 'pause_too_large',
      message:
        `job ${jobId} paused with ${json.length} characters of output; a paused output must be a ` +
        'pointer, not state. Something is writing run state into the orchestration output again.',
    },
  };
}
