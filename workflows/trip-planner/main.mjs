import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { withStandaloneLease } from '../standalone.mjs';
import { ensureApralabs } from '../../transport/ensure-apralabs.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const engineScript = path.join(here, 'trip-planner.js');

export const selfExecuting = true;

export async function runTripPlanner({ fleetApi, workspace, destination, from, country, days, signal, reportPhase, memories } = {}) {
  ensureApralabs();
  if (!fleetApi) {
    return withStandaloneLease((ctx) => runTripPlanner({ ...ctx, destination, from, country, days, reportPhase }));
  }
  const { FleetWorkflow } = await import('@apralabs/apra-fleet-workflow');
  const { WorkflowEngine } = await import('@apralabs/apra-fleet-workflow/engine');

  const workflow = new FleetWorkflow(fleetApi);
  const engine = new WorkflowEngine(workflow);
  return await engine.executeFile(engineScript, {
    fleetApi,
    workspace,
    destination: destination || 'London',
    from: from || '',
    country: country || destination || 'UK',
    days: days ?? 7,
    signal,
    reportPhase,
    memories: memories ?? [],
  });
}

function isMainModule() {
  const entry = process.argv[1];
  if (!entry) return false;
  return pathToFileURL(path.resolve(entry)).href === import.meta.url;
}

if (isMainModule()) {
  try {
    const destination = process.argv[2] || 'London';
    const from = process.argv[3] || '';
    const result = await runTripPlanner({ destination, from });
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.message ?? err);
    process.exit(1);
  }
}
