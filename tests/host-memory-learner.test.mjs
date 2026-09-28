import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createLearner } from '../host/memory/learner.mjs';

function mockLtm() {
  const stored = [];
  const promoted = [];
  return {
    store: async (entry) => { stored.push(entry); return { action: 'created', entry }; },
    promote: async (id) => { promoted.push(id); return { id, retrievalStrength: 1.0 }; },
    _stored: stored,
    _promoted: promoted,
  };
}

function mcpResponse(text) {
  return { content: [{ type: 'text', text }], isError: false };
}

function mcpError(text) {
  return { content: [{ type: 'text', text }], isError: true };
}

test('learner extracts facts from LLM response', async () => {
  const ltm = mockLtm();
  const api = {
    executePrompt: async () => mcpResponse('```json\n{"newFacts": [{"kind": "pattern", "text": "Rounding causes mismatches", "tags": ["invoices"]}], "usedRecalledIds": ["mem-abc"]}\n```'),
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Find mismatches', history: [], recalledFacts: [{ id: 'mem-abc', kind: 'domain', text: 'Threshold is 0.01' }] });
  assert.equal(result.newFacts.length, 1);
  assert.equal(result.promotedIds.length, 1);
  assert.equal(ltm._stored[0].kind, 'pattern');
  assert.equal(ltm._promoted[0], 'mem-abc');
});

test('learner filters out rule kind', async () => {
  const ltm = mockLtm();
  const api = {
    executePrompt: async () => mcpResponse('```json\n{"newFacts": [{"kind": "rule", "text": "Should not be stored", "tags": []}], "usedRecalledIds": []}\n```'),
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
  assert.equal(ltm._stored.length, 0);
});

test('learner handles LLM failure gracefully', async () => {
  const ltm = mockLtm();
  const api = { executePrompt: async () => { throw new Error('LLM down'); } };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
  assert.equal(result.promotedIds.length, 0);
});

test('learner handles malformed JSON gracefully', async () => {
  const ltm = mockLtm();
  const api = { executePrompt: async () => mcpResponse('No JSON here, just text.') };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(result.newFacts.length, 0);
});

test('learner serializes object results in history instead of [object Object]', async () => {
  const ltm = mockLtm();
  let capturedPrompt;
  const api = {
    executePrompt: async ({ prompt }) => {
      capturedPrompt = prompt;
      return mcpResponse('```json\n{"newFacts": [], "usedRecalledIds": []}\n```');
    },
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  await learner.extract({
    task: 'Plan trip',
    history: [
      { type: 'observation', stepType: 'tool', tool: 'weather', result: { ok: true, result: '{"temp":30}' } },
      { type: 'observation', stepType: 'reason', text: 'The weather is warm.' },
    ],
    recalledFacts: [],
  });
  assert.ok(!capturedPrompt.includes('[object Object]'), 'prompt must not contain [object Object]');
  assert.ok(capturedPrompt.includes('"ok":true'), 'prompt should contain serialized tool result');
  assert.ok(capturedPrompt.includes('The weather is warm'), 'prompt should contain reason text');
});

test('learner truncates long history entries', async () => {
  const ltm = mockLtm();
  let capturedPrompt;
  const api = {
    executePrompt: async ({ prompt }) => {
      capturedPrompt = prompt;
      return mcpResponse('```json\n{"newFacts": [], "usedRecalledIds": []}\n```');
    },
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} } });
  const longText = 'x'.repeat(1000);
  await learner.extract({
    task: 'Test',
    history: [{ type: 'observation', text: longText }],
    recalledFacts: [],
  });
  assert.ok(capturedPrompt.length < longText.length + 500, 'prompt should truncate long entries');
  assert.ok(capturedPrompt.includes('…'), 'truncated entry should end with ellipsis');
});

test('learner retries on isError MCP response', async () => {
  const ltm = mockLtm();
  let attempts = 0;
  const api = {
    executePrompt: async () => {
      attempts++;
      if (attempts <= 2) return mcpError('member not found');
      return mcpResponse('```json\n{"newFacts": [{"kind": "domain", "text": "Retry worked", "tags": ["test"]}], "usedRecalledIds": []}\n```');
    },
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: api, logger: { info() {}, warn() {} }, retryDelayMs: 10 });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [] });
  assert.equal(attempts, 3, 'should retry twice then succeed on third');
  assert.equal(result.newFacts.length, 1);
  assert.equal(ltm._stored[0].text, 'Retry worked');
});

test('learner uses per-call fleetApi override', async () => {
  const ltm = mockLtm();
  let defaultCalled = false;
  let overrideCalled = false;
  const defaultApi = {
    executePrompt: async () => { defaultCalled = true; return mcpResponse('```json\n{"newFacts": [], "usedRecalledIds": []}\n```'); },
  };
  const overrideApi = {
    executePrompt: async () => { overrideCalled = true; return mcpResponse('```json\n{"newFacts": [{"kind": "domain", "text": "From override", "tags": []}], "usedRecalledIds": []}\n```'); },
  };
  const learner = createLearner({ longTermMemory: ltm, fleetApi: defaultApi, logger: { info() {}, warn() {} } });
  const result = await learner.extract({ task: 'Test', history: [], recalledFacts: [], fleetApi: overrideApi });
  assert.equal(defaultCalled, false, 'should not use default fleetApi');
  assert.equal(overrideCalled, true, 'should use override fleetApi');
  assert.equal(result.newFacts.length, 1);
});
