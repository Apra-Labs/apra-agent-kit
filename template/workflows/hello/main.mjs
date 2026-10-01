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

export async function runHello({ fleetApi, workspace, signal, reportPhase, name } = {}) {
  if (!fleetApi) {
    // CLI run: spawn Fleet, take one lease, run, release.
    return withStandaloneLease((ctx) => runHello({ ...ctx, reportPhase, name }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet/packages/apra-fleet-workflow/src/workflow/index.mjs');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet/packages/apra-fleet-workflow/src/workflow/engine.mjs');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, { fleetApi, workspace, signal, reportPhase, name });
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
    console.log(`\n  ${result.greeting}\n  (host: ${result.host}, who: ${result.who})\n`);
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
