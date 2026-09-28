import { executeTool } from './tools/executor.mjs';

const VALID_PATHS = new Set(['workflow', 'open-ended', 'plan-execute']);
const CLASSIFY_TIMEOUT_MS = 30_000;

export function buildClassifierPrompt(goal, registry) {
  const routable = registry.filter(t => t.routing);
  const workflowLines = routable.map(t => {
    const argDesc = Object.entries(t.routing.args ?? {})
      .map(([k, v]) => `${k}: ${v.extract}`)
      .join(', ');
    return `- ${t.name}: ${t.routing.description} (extract: ${argDesc || 'none'})`;
  }).join('\n');

  const workflowSection = routable.length > 0
    ? `WORKFLOWS (fastest — always prefer these when the goal can be served by one):\n${workflowLines}\n\n`
    : '';

  return `You are a task router. Your job is to pick the fastest execution path for the user's goal.

RULES:
1. ALWAYS pick a workflow if the goal can be FULLY served by one, even loosely. Workflows are faster and cheaper.
2. If the goal mentions MULTIPLE destinations or legs (e.g. "go to X then Y", "travel from A to B then to C"), pick plan-execute — no single workflow handles multi-leg trips.
3. Pick open-ended ONLY when no workflow fits at all (e.g. general chat, opinions, or questions needing tools not listed above).
4. Pick plan-execute for complex multi-step tasks that no single workflow can handle.
5. When extracting args, use the most specific place name from the goal. If the user says a region/state, use its most well-known city.

${workflowSection}FALLBACK STRATEGIES (only when no workflow fits):
- open-ended: General questions, opinions, or tasks needing unlisted tools.
- plan-execute: Complex multi-step tasks needing a plan with many tools in dynamic order.

User's goal: "${goal}"

Respond with ONLY a JSON object:
{"path":"workflow|open-ended|plan-execute","workflow":"name-if-workflow","args":{extracted args}}`;
}

export function parseClassifierResponse(text, { routableNames, fallbackStrategy }) {
  const fallback = { path: fallbackStrategy };
  if (!text || typeof text !== 'string') return fallback;

  let cleaned = text.trim();
  const fenceMatch = cleaned.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) cleaned = fenceMatch[1].trim();

  let parsed;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    const braceStart = cleaned.indexOf('{');
    const braceEnd = cleaned.lastIndexOf('}');
    if (braceStart >= 0 && braceEnd > braceStart) {
      try { parsed = JSON.parse(cleaned.slice(braceStart, braceEnd + 1)); } catch { /* fall through */ }
    }
    if (!parsed) return fallback;
  }

  if (!parsed || typeof parsed !== 'object') return fallback;
  if (!VALID_PATHS.has(parsed.path)) return fallback;

  if (parsed.path === 'workflow') {
    if (!parsed.workflow || !routableNames.has(parsed.workflow)) return fallback;
    return { path: 'workflow', workflow: parsed.workflow, args: parsed.args ?? {} };
  }

  return { path: parsed.path };
}

function extractText(mcpResult) {
  if (!mcpResult) return '';
  if (typeof mcpResult === 'string') return mcpResult;
  return (mcpResult.content ?? []).map(p => p.text ?? '').join('\n');
}

function abortError(message = 'aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

export async function classify(goal, { fleetApi, registry, fallbackStrategy, signal }) {
  const routableNames = new Set(registry.filter(t => t.routing).map(t => t.name));
  const fallback = { path: fallbackStrategy };
  if (signal?.aborted) return fallback;

  const prompt = buildClassifierPrompt(goal, registry);

  try {
    const timeoutSignal = AbortSignal.timeout(CLASSIFY_TIMEOUT_MS);
    const combined = signal ? AbortSignal.any([signal, timeoutSignal]) : timeoutSignal;
    if (combined.aborted) return fallback;

    const raw = await Promise.race([
      fleetApi.executePrompt({ member_name: 'doer', prompt, signal: combined }),
      new Promise((_, reject) => {
        const onAbort = () => reject(abortError('classify aborted'));
        if (combined.aborted) {
          onAbort();
          return;
        }
        combined.addEventListener('abort', onAbort, { once: true });
      }),
    ]);
    const text = extractText(raw);
    const result = parseClassifierResponse(text, { routableNames, fallbackStrategy });
    Object.defineProperty(result, '_debug', { value: { raw: text?.slice(0, 300), routable: [...routableNames] }, enumerable: false });
    return result;
  } catch (err) {
    const fb = { ...fallback };
    Object.defineProperty(fb, '_debug', { value: { error: String(err?.message ?? err) }, enumerable: false });
    return fb;
  }
}

function unwrapWorkflowResult(result) {
  if (result && typeof result === 'object' && typeof result.answer === 'string') {
    return result.answer;
  }
  if (typeof result === 'string') {
    const marker = 'completed:';
    const idx = result.lastIndexOf(marker);
    if (idx !== -1) {
      const jsonPart = result.slice(idx + marker.length).trim();
      try {
        const parsed = JSON.parse(jsonPart);
        if (parsed && typeof parsed.answer === 'string') return parsed.answer;
      } catch {
        // keep original string
      }
    }
    return result;
  }
  return JSON.stringify(result);
}

function adaptReportPhase(onProgress) {
  if (!onProgress) {
    const noop = () => {};
    noop.complete = () => {};
    return noop;
  }
  let iteration = 0;
  let stepIndex = -1;
  let currentStep = null;

  async function completeCurrentStep() {
    if (currentStep) {
      iteration += 1;
      try {
        await onProgress({ iteration, kind: 'step_completed', message: `completed: ${currentStep}`, stepIndex, step: { type: 'tool', tool: currentStep }, result: { ok: true } });
      } catch { /* best-effort */ }
      currentStep = null;
    }
  }

  const report = async (messageOrObj) => {
    if (typeof messageOrObj === 'string') {
      await completeCurrentStep();
      stepIndex += 1;
      iteration += 1;
      currentStep = messageOrObj;
      return onProgress({ iteration, kind: 'step_started', message: messageOrObj, stepIndex, step: { type: 'tool', tool: messageOrObj } });
    }
    return onProgress(messageOrObj);
  };
  report.complete = completeCurrentStep;
  return report;
}

export async function executeWorkflow(name, args, { fleetApi, toolRegistry, signal, onProgress, workspace }) {
  const entry = toolRegistry.find(t => t.name === name && t.routing);
  if (!entry) {
    return { status: 'failed', result: { error: 'workflow_not_found', message: `Workflow "${name}" not found` }, history: [], budget: null };
  }

  const reportPhase = adaptReportPhase(onProgress);
  const executed = await executeTool(entry, {
    fleetApi,
    args: args ?? {},
    signal,
    reportPhase,
    workspace,
  });
  await reportPhase.complete();

  if (!executed.ok) {
    if (executed.error === 'timeout' && signal?.aborted) {
      return { status: 'cancelled', result: null, history: [], budget: null };
    }
    const error = executed.error === 'validation_failed' ? 'validation_failed'
      : executed.error === 'timeout' ? 'timeout'
      : executed.error === 'tool_error' ? 'workflow_failed'
      : executed.error ?? 'workflow_failed';
    return {
      status: 'failed',
      result: {
        error,
        message: executed.message ?? (error === 'validation_failed' ? 'invalid workflow args' : String(error)),
        ...(executed.details ? { details: executed.details } : {}),
      },
      history: [],
      budget: null,
    };
  }

  return {
    status: 'completed',
    result: unwrapWorkflowResult(executed.result),
    history: [],
    budget: null,
  };
}
