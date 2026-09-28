import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createConversationSqliteStore } from '../host/memory/conversation-store/sqlite.mjs';
import { createConversationContext } from '../host/memory/conversation-context.mjs';
import { createFsrs6Engine } from '../host/memory/decay/fsrs6.mjs';

let store, ctx, dbPath;
const engine = createFsrs6Engine();
const noopApi = { executePrompt: async () => 'Summary of conversation.' };
const silentLogger = { info() {}, warn() {}, error() {} };

beforeEach(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conv-ctx-'));
  dbPath = path.join(dir, 'conversation.db');
  store = createConversationSqliteStore({ dbPath });
  await store.open();
});

afterEach(async () => {
  if (ctx?.close) await ctx.close();
  await store.close();
});

test('recordTurn stores a turn and forPrompt retrieves it', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, logger: silentLogger });
  await ctx.recordTurn('ses-1', { goal: 'Hello', answer: 'Hi there', status: 'completed' });
  const prompt = await ctx.forPrompt('ses-1');
  assert.ok(prompt.length >= 1);
  assert.ok(prompt.some(t => t.goal === 'Hello'));
});

test('forPrompt returns empty array for unknown session', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, logger: silentLogger });
  const prompt = await ctx.forPrompt('ses-unknown');
  assert.deepEqual(prompt, []);
});

test('answer is truncated to answerMaxChars', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, answerMaxChars: 20, logger: silentLogger });
  await ctx.recordTurn('ses-2', { goal: 'Q', answer: 'A'.repeat(100), status: 'completed' });
  const turns = await store.listSession('ses-2');
  assert.ok(turns[0].answer.length <= 20);
});

test('maxTotalTurns drops oldest when exceeded', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, maxTotalTurns: 3, logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-3', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const all = await store.listSession('ses-3');
  assert.ok(all.length <= 3);
});

test('compaction summarises older turns', async () => {
  let summaryCalled = false;
  const fakeApi = {
    executePrompt: async () => { summaryCalled = true; return 'Conversation summary.'; },
  };
  ctx = createConversationContext({ store, engine, fleetApi: fakeApi, maxRecentTurns: 2, logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-4', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const prompt = await ctx.forPrompt('ses-4');
  assert.ok(summaryCalled);
  assert.ok(prompt.some(t => t.role === 'summary'));
});

test('compaction falls back to sliding-window when summarisation fails', async () => {
  const failApi = { executePrompt: async () => { throw new Error('LLM down'); } };
  ctx = createConversationContext({ store, engine, fleetApi: failApi, maxRecentTurns: 2, logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-5', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const prompt = await ctx.forPrompt('ses-5');
  assert.ok(prompt.length <= 2);
  assert.ok(!prompt.some(t => t.role === 'summary'));
});

test('sliding-window strategy skips summarisation', async () => {
  let called = false;
  const spyApi = { executePrompt: async () => { called = true; return 'Summary.'; } };
  ctx = createConversationContext({ store, engine, fleetApi: spyApi, maxRecentTurns: 2, compactionStrategy: 'sliding-window', logger: silentLogger });
  for (let i = 0; i < 5; i++) {
    await ctx.recordTurn('ses-6', { goal: `g${i}`, answer: `a${i}`, status: 'completed' });
  }
  const prompt = await ctx.forPrompt('ses-6');
  assert.equal(called, false);
  assert.ok(prompt.length <= 2);
});

test('decay transitions old turns to dormant/silent', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, maxRecentTurns: 10, logger: silentLogger });
  await ctx.recordTurn('ses-7', { goal: 'old', answer: 'old-a', status: 'completed' });
  // Manually age the turn's lastPromotedAt to 90 days ago and set stability low
  const turns = await store.listSession('ses-7');
  const aged = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  await store.update(turns[0].id, { lastPromotedAt: aged, stability: 0.1, createdAt: aged });
  const prompt = await ctx.forPrompt('ses-7');
  // After decay, the turn should be dormant or silent and may be excluded
  const updated = await store.get(turns[0].id);
  assert.notEqual(updated.state, 'active');
});

test('promoteTurn boosts retrievalStrength', async () => {
  ctx = createConversationContext({ store, engine, fleetApi: noopApi, logger: silentLogger });
  await ctx.recordTurn('ses-8', { goal: 'q', answer: 'a', status: 'completed' });
  const turns = await store.listSession('ses-8');
  // Age it slightly so promote has an effect
  const aged = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
  await store.update(turns[0].id, { lastPromotedAt: aged });
  await ctx.promoteTurn('ses-8', turns[0].id);
  const updated = await store.get(turns[0].id);
  assert.equal(updated.state, 'active');
  assert.ok(updated.lastPromotedAt > aged);
});
