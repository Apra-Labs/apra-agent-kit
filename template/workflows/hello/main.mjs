// The launcher owns spawning Fleet, leasing a worker pair, and cleanup. The
// body in hello.js owns the work. That split is what keeps the body testable
// with no binary and no token.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'hello.js');

export const selfExecuting = true;

function extractText(raw) {
  if (typeof raw === 'string') return raw;
  return (raw?.content ?? []).map(p => p.text ?? '').join('');
}

export async function runHello({ fleetApi, workspace, signal, reportPhase, name } = {}) {
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runHello({ ...ctx, reportPhase, name }));
  }

  try {
    const { FleetWorkflow } = await import('@apralabs/apra-fleet/packages/apra-fleet-workflow/src/workflow/index.mjs');
    const { WorkflowEngine } = await import('@apralabs/apra-fleet/packages/apra-fleet-workflow/src/workflow/engine.mjs');
    const workflow = new FleetWorkflow(fleetApi);
    const engine = new WorkflowEngine(workflow);
    return await engine.executeFile(engineScript, { fleetApi, workspace, signal, reportPhase, name });
  } catch (err) {
    if (err?.code !== 'ERR_MODULE_NOT_FOUND') throw err;

    console.warn(
      '[hello] @apralabs/apra-fleet not found — running without the workflow engine.\n' +
      '        Engine features (budgets, journaling, structured output) are unavailable.\n' +
      '        Fix: npm install @apralabs/apra-fleet   or see docs/getting-started.md',
    );
    const { main } = await import('./hello.js');
    return main({
      command: async (cmd, o = {}) => extractText(
        await fleetApi.executeCommand({ member_name: o.member_name ?? 'doer', command: cmd }),
      ),
      agent: async (prompt, o = {}) => extractText(
        await fleetApi.executePrompt({ member_name: o.member_name ?? 'doer', prompt }),
      ),
      log: (msg) => console.log(`[Workflow Log] ${msg}`),
      args: { name },
    });
  }
}

function isMainModule() {
  const invoked = process.argv[1];
  if (!invoked) return false;
  try {
    return fs.realpathSync(invoked) === fs.realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return path.resolve(invoked) === fileURLToPath(import.meta.url);
  }
}

if (isMainModule()) {
  try {
    const result = await runHello({ name: process.argv[2] });
    if (result && typeof result === 'object' && result.greeting) {
      console.log(`\n  ${result.greeting}\n  (host: ${result.host}, who: ${result.who})\n`);
    } else {
      console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    }
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
