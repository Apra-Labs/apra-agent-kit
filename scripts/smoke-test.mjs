#!/usr/bin/env node
// scripts/smoke-test.mjs
//
// One-command E2E smoke test against a real or mock host.
//
//   npm run smoke          — mock fleet, no API key, fast (~30s)
//   npm run smoke:live     — real fleet + real LLM, needs CLAUDE_CODE_OAUTH_TOKEN
//
// Boots the server, waits for /health, runs the E2E suite, prints a summary,
// tears everything down, and exits 0 (pass) or 1 (fail).

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

const MODE = process.argv.includes('--live') ? 'live' : 'scripted';
const PORT = Number(process.env.SMOKE_PORT ?? 0);
const HEALTH_TIMEOUT_MS = MODE === 'live' ? 60_000 : 30_000;
const TEST_TIMEOUT_MS = MODE === 'live' ? 600_000 : 120_000;

console.log(`\n  Smoke test — mode: ${MODE}, port: ${PORT || 'auto'}\n`);

// ── 1. Boot the host ────────────────────────────────────────────────────────

const serverEnv = {
  ...process.env,
  PORT: String(PORT),
  NODE_ENV: 'test',
  SCHEDULER_ENABLED: 'false',
  JOBS_CONCURRENCY: '1',
  JOBS_MAX_QUEUE_SIZE: '1',
  WEBHOOK_ALLOW_HTTP: 'true',
};

let serverEntry;
if (MODE === 'scripted') {
  serverEnv.FLEET_MOCK_SCRIPT = path.join(root, 'tests/e2e/scripted-llm.json');
  serverEntry = path.join(root, 'host/index.mjs');
} else {
  if (!process.env.CLAUDE_CODE_OAUTH_TOKEN) {
    console.error('  ERROR: CLAUDE_CODE_OAUTH_TOKEN is required for --live mode.');
    console.error('  Run: export CLAUDE_CODE_OAUTH_TOKEN="$(claude setup-token)"');
    process.exit(1);
  }
  serverEntry = path.join(root, 'host/index.mjs');
}

const server = spawn(process.execPath, [serverEntry], {
  cwd: root,
  env: serverEnv,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let serverPort = PORT;
let serverOutput = '';

server.stdout.on('data', (d) => {
  const chunk = d.toString();
  serverOutput += chunk;
  process.stdout.write(`  [host] ${chunk}`);

  // Detect the port from the host's output if we used port 0
  if (!serverPort) {
    const m = chunk.match(/(?:listening|started|running)\b.*?(?::|\bport\s+)(\d{4,5})/i)
      ?? chunk.match(/localhost:(\d{4,5})/i)
      ?? chunk.match(/:(\d{4,5})/);
    if (m) serverPort = Number(m[1]);
  }
});

server.stderr.on('data', (d) => {
  const chunk = d.toString();
  serverOutput += chunk;
  process.stderr.write(`  [host] ${chunk}`);
});

function killServer() {
  if (!server.killed) {
    server.kill('SIGTERM');
    setTimeout(() => { if (!server.killed) server.kill('SIGKILL'); }, 5000);
  }
}

process.on('SIGINT', () => { killServer(); process.exit(130); });
process.on('SIGTERM', () => { killServer(); process.exit(143); });

// ── 2. Wait for /health ─────────────────────────────────────────────────────

async function waitHealthy() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  // If port is 0/auto, wait for the host to print it
  while (!serverPort && Date.now() < deadline) {
    await sleep(200);
  }
  if (!serverPort) throw new Error('server never printed a port');

  console.log(`  Waiting for http://127.0.0.1:${serverPort}/health ...`);

  while (Date.now() < deadline) {
    try {
      const r = await fetch(`http://127.0.0.1:${serverPort}/health`);
      if (r.ok) {
        console.log('  Server healthy.\n');
        return;
      }
    } catch { /* not up yet */ }
    await sleep(500);
  }
  throw new Error(`server did not become healthy within ${HEALTH_TIMEOUT_MS}ms`);
}

try {
  await waitHealthy();
} catch (err) {
  console.error(`\n  FAILED: ${err.message}`);
  console.error('  Server output:\n', serverOutput.slice(-2000));
  killServer();
  process.exit(1);
}

// ── 3. Run the E2E suite ────────────────────────────────────────────────────

const testEnv = {
  ...process.env,
  BASE_URL: `http://127.0.0.1:${serverPort}`,
  E2E_MODE: MODE,
  E2E_TARGET: 'vm',
  WEBHOOK_RECEIVER_HOST: '127.0.0.1',
};

console.log(`  Running E2E tests against http://127.0.0.1:${serverPort} (mode=${MODE})...\n`);

const testProc = spawn(
  process.execPath,
  ['--test', '--test-timeout', String(TEST_TIMEOUT_MS), 'tests/e2e/task.e2e.test.mjs'],
  { cwd: root, env: testEnv, stdio: 'inherit' },
);

const testExit = await new Promise((resolve) => {
  testProc.on('close', resolve);
});

// ── 4. Tear down ────────────────────────────────────────────────────────────

killServer();
await new Promise((resolve) => server.on('close', resolve));

if (testExit === 0) {
  console.log('\n  ✓ Smoke test passed.\n');
} else {
  console.error(`\n  ✗ Smoke test failed (exit ${testExit}).\n`);
}

process.exit(testExit);
