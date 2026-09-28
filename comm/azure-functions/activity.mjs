// comm/azure-functions/activity.mjs
// The run loop inside a Durable activity. Progress events are pushed directly
// to the jobs backend's SSE subscribers (bypassing the orchestrator) so the
// chat UI can show tool execution in real time.
import { executeHostedTask, settleWhenAborted } from '../../host/tasks.mjs';
import { settleFromRunResult } from '../../host/jobs/record.mjs';

let factory = null;
let contextPromise = null;

export function setHostContextFactory(fn) {
  factory = fn;
  contextPromise = null;
}

export function getHostContext() {
  if (!factory) return Promise.reject(new Error('host context factory not set; call setHostContextFactory first'));
  contextPromise ??= Promise.resolve().then(factory);
  return contextPromise;
}

export function createRunTaskActivity({ getClient, pollMs = 2000, getContext = getHostContext }) {
  return async function runTaskActivity(input, context) {
    const { jobId, task, callbackUrl } = input;
    const client = getClient(context);
    const hostCtx = await getContext();
    const controller = new AbortController();
    const iso = () => new Date().toISOString();

    const emit = (event) => {
      if (hostCtx.jobs?.emitEvent) {
        hostCtx.jobs.emitEvent(jobId, event);
      }
    };

    const cancelPoll = setInterval(async () => {
      try {
        const st = await client.getStatus(jobId, { showHistory: false, showInput: false });
        if (st?.customStatus?.cancelRequested && !controller.signal.aborted) controller.abort('cancelled');
      } catch { /* transient; next tick retries */ }
    }, pollMs);
    cancelPoll.unref?.();

    try {
      const run = await settleWhenAborted(
        executeHostedTask({ ...task, id: jobId }, {
          api: hostCtx.api,
          activeDispatcher: hostCtx.activeDispatcher,
          toolRegistry: hostCtx.toolRegistry,
          runLoopConfig: hostCtx.runLoopConfig,
          routerConfig: hostCtx.routerConfig,
          budgetsConfig: hostCtx.budgetsConfig,
          guardrailsMod: hostCtx.guardrailsMod,
          memory: hostCtx.memory,
          logger: hostCtx.logger,
          signal: controller.signal,
          onProgress: (progress) => emit({ type: 'progress', jobId, at: iso(), ...progress }),
        }),
        controller.signal,
      );
      const settled = settleFromRunResult(run);
      if (controller.signal.aborted && controller.signal.reason === 'cancelled') {
        settled.status = 'cancelled';
        settled.result = null;
        settled.error = null;
      }
      emit({ type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result ?? null, error: settled.error ?? null, routedTo: run.routedTo ?? null });
      if (hostCtx.notifier && callbackUrl) {
        await hostCtx.notifier.publish(
          { type: 'settled', jobId, at: iso(), status: settled.status, result: settled.result, error: settled.error },
          { callbackUrl },
        );
      }
      // Durable Functions caps activity return values at 16 KB (UTF-16).
      // UTF-16 doubles the byte count, so 16 KB UTF-16 = 8K chars max.
      // The full result is already emitted via SSE (emit) and webhook
      // (notifier) above, so the orchestrator only needs a slim payload.
      const { history, budget, ...trimmed } = settled;
      if (run.routedTo) trimmed.routedTo = run.routedTo;
      const MAX_CHARS = 7500;
      let json = JSON.stringify(trimmed);
      if (json.length > MAX_CHARS && typeof trimmed.result === 'string') {
        const overhead = json.length - trimmed.result.length;
        const room = Math.max(200, MAX_CHARS - overhead - 50);
        trimmed.result = trimmed.result.slice(0, room) + '\n\n[Full result delivered via SSE]';
        json = JSON.stringify(trimmed);
      }
      if (json.length > MAX_CHARS) {
        return { status: trimmed.status, routedTo: trimmed.routedTo ?? null, result: '[Full result delivered via SSE]', error: trimmed.error ?? null };
      }
      return trimmed;
    } finally {
      clearInterval(cancelPoll);
    }
  };
}
