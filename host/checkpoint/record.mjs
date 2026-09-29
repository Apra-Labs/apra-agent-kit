// host/checkpoint/record.mjs
//
// The one record a run checkpoints to.
//
// It replaces two: `host/memory/run-state.mjs`, written after each step for
// crash recovery, and `host/human-input/snapshot.mjs`, written at a pause.
// Three facts lived in both — the plan, the step cursor, and the observations
// — with two writers, two homes, and nothing saying which won when they
// disagreed.
//
// This module knows only the shape. Where it lands, and when, is
// `host/checkpoint/index.mjs`.

import { assertSafeMemoryId } from '../memory/store/interface.mjs';

export const CHECKPOINT_VERSION = 1;

/**
 * The row a run's checkpoint lives in.
 *
 * Keyed on the task id alone. The retired run-state keyed on
 * `task.id ?? task.goal`, so two concurrent runs of the same goal shared one
 * row and silently clobbered each other. A task with no id has no identity to
 * key on, and inventing one would hide the same bug rather than fix it.
 */
export function checkpointKey(task) {
  const id = task?.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('checkpointKey requires an id on the task; a goal is not unique');
  }
  assertSafeMemoryId(id);
  return `cp-${id}`;
}

// Anything that looks like proof of identity rather than identity itself.
// Matched case-insensitively against key names at every depth.
const CREDENTIAL_KEYS = [
  'token', 'accesstoken', 'refreshtoken', 'idtoken', 'bearer',
  'authorization', 'auth', 'apikey', 'api_key', 'secret',
  'password', 'passwd', 'credential', 'credentials', 'cookie', 'sessionid',
];

const isCredentialKey = (key) => {
  const k = String(key).toLowerCase().replace(/[-_]/g, '');
  return CREDENTIAL_KEYS.some(c => k === c.replace(/[-_]/g, ''));
};

/**
 * Strip credential-shaped keys from arbitrary nested state.
 *
 * `conversation` and `observations` carry whatever the strategies put there,
 * which we do not control, and this sits in a store for as long as the run
 * takes. Second line of defence behind the identity allow-list below.
 */
export function scrub(value, seen = new WeakSet()) {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return null;      // a cycle cannot be serialised anyway
  seen.add(value);

  if (Array.isArray(value)) return value.map(v => scrub(v, seen));

  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (isCredentialKey(k)) continue;
    out[k] = scrub(v, seen);
  }
  return out;
}

// Allow-listed rather than filtered, because a filter only removes the
// credential shapes we thought of. Add a field here deliberately or it does
// not survive a checkpoint.
function safeIdentity(identity) {
  if (!identity || typeof identity !== 'object') return null;
  const out = {};
  if (identity.personId != null) out.personId = identity.personId;
  if (identity.tenantId != null) out.tenantId = identity.tenantId;
  return Object.keys(out).length === 0 ? null : out;
}

/**
 * Build the record.
 *
 * Everything here is also derivable from history — that is the contract that
 * keeps the checkpoint a cache rather than a second source of truth. A field
 * added here that is *not* derivable means `rebuildFromHistory` must learn to
 * produce it too, or a cold resume silently loses it.
 */
export function createCheckpointRecord({
  taskKey, jobId = null, traceId = null, kitVersion = null,
  task = null, agentName = null, agentDescription = null, strategy = null,
  plan = null, observations = [], idempotencyKeys = [],
  conversation = [], recalledFacts = [],
  budget = null, interruptions = 0,
  identity = null, pendingBatchId = null, workspace = null,
  writtenAt = new Date(),
} = {}) {
  return {
    version: CHECKPOINT_VERSION,
    kitVersion,
    taskKey, jobId, traceId,
    writtenAt: (writtenAt instanceof Date ? writtenAt : new Date(writtenAt)).toISOString(),

    // what the run is
    task: scrub(task),
    agentName, agentDescription, strategy,

    // where it got to
    plan: plan ? { steps: scrub(plan.steps ?? []), cursor: plan.cursor ?? 0 } : null,
    observations: scrub(observations),
    idempotencyKeys: [...idempotencyKeys],

    // what it was given, so a resume reproduces the prompt it had
    conversation: scrub(conversation),
    recalledFacts: scrub(recalledFacts),

    // accounting
    budget: budget ? { ...budget } : null,
    // MUST persist. Without it `maxInterruptions` resets on every resume and
    // never trips — a run could ask forever, one question per resume.
    interruptions,

    // who, and what it is waiting on
    identity: safeIdentity(identity),
    pendingBatchId,
    // Recorded for incidents, not for resume: a resume deliberately takes a
    // fresh worker. It is here so "which worker did this" is answerable.
    workspace: workspace ? { workerId: workspace.workerId ?? null } : null,
  };
}

/**
 * Read a checkpoint back.
 *
 * Refuses rather than guesses. A record written by a different build may have
 * meant something different by the same field name, and resuming on a misread
 * plan cursor re-executes work that already happened.
 *
 * @returns {{ok: true, checkpoint: object} | {ok: false, reason: string, detail?: any}}
 */
export function validateCheckpoint(raw) {
  if (raw == null) return { ok: false, reason: 'absent' };
  if (typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: 'unreadable' };
  if (raw.version !== CHECKPOINT_VERSION) {
    return {
      ok: false,
      reason: 'incompatible_version',
      detail: { found: raw.version ?? null, expected: CHECKPOINT_VERSION },
    };
  }
  if (typeof raw.taskKey !== 'string' || !raw.taskKey) {
    return { ok: false, reason: 'unreadable', detail: 'taskKey' };
  }

  return {
    ok: true,
    checkpoint: {
      ...raw,
      observations: raw.observations ?? [],
      idempotencyKeys: raw.idempotencyKeys ?? [],
      conversation: raw.conversation ?? [],
      recalledFacts: raw.recalledFacts ?? [],
      interruptions: raw.interruptions ?? 0,
      plan: raw.plan ?? null,
    },
  };
}
