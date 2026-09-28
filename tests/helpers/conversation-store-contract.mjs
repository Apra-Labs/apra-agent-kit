import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertConversationStore } from '../../host/memory/conversation-store/interface.mjs';

export function conversationStoreContractTests(createStore) {
  test('assertConversationStore validates the adapter', async () => {
    const store = await createStore();
    assert.doesNotThrow(() => assertConversationStore(store));
    await store.close();
  });

  test('append and get a turn', async () => {
    const store = await createStore();
    const turn = {
      id: 'ct-aaa', sessionId: 'ses-111', turnIndex: 0,
      goal: 'Find flights to Tokyo', answer: 'Here are 3 flights...',
      status: 'completed', createdAt: new Date().toISOString(),
      retrievalStrength: 1.0, stability: 1.0, state: 'active',
      lastPromotedAt: new Date().toISOString(), summary: null,
    };
    await store.append(turn);
    const got = await store.get('ct-aaa');
    assert.equal(got.id, 'ct-aaa');
    assert.equal(got.goal, 'Find flights to Tokyo');
    assert.equal(got.sessionId, 'ses-111');
    await store.close();
  });

  test('listSession returns turns ordered by turnIndex', async () => {
    const store = await createStore();
    const base = { sessionId: 'ses-222', status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    await store.append({ ...base, id: 'ct-b', turnIndex: 1, goal: 'second', answer: 'b' });
    await store.append({ ...base, id: 'ct-a', turnIndex: 0, goal: 'first', answer: 'a' });
    const turns = await store.listSession('ses-222');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].goal, 'first');
    assert.equal(turns[1].goal, 'second');
    await store.close();
  });

  test('listSession filters by state', async () => {
    const store = await createStore();
    const base = { sessionId: 'ses-333', status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, lastPromotedAt: null, summary: null };
    await store.append({ ...base, id: 'ct-x', turnIndex: 0, goal: 'g1', answer: 'a1', state: 'active' });
    await store.append({ ...base, id: 'ct-y', turnIndex: 1, goal: 'g2', answer: 'a2', state: 'silent' });
    const active = await store.listSession('ses-333', { states: ['active'] });
    assert.equal(active.length, 1);
    assert.equal(active[0].id, 'ct-x');
    await store.close();
  });

  test('listSession respects limit', async () => {
    const store = await createStore();
    const base = { sessionId: 'ses-444', status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    for (let i = 0; i < 5; i++) {
      await store.append({ ...base, id: `ct-${i}`, turnIndex: i, goal: `g${i}`, answer: `a${i}` });
    }
    const limited = await store.listSession('ses-444', { limit: 3 });
    assert.equal(limited.length, 3);
    await store.close();
  });

  test('update patches a turn', async () => {
    const store = await createStore();
    const turn = { id: 'ct-upd', sessionId: 'ses-555', turnIndex: 0, goal: 'g', answer: null, status: 'completed', createdAt: new Date().toISOString(), retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    await store.append(turn);
    const updated = await store.update('ct-upd', { answer: 'done', retrievalStrength: 0.8, state: 'dormant' });
    assert.equal(updated.answer, 'done');
    assert.equal(updated.retrievalStrength, 0.8);
    assert.equal(updated.state, 'dormant');
    await store.close();
  });

  test('purgeSessions removes old sessions', async () => {
    const store = await createStore();
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
    const recent = new Date().toISOString();
    const base = { status: 'completed', retrievalStrength: 1.0, stability: 1.0, state: 'active', lastPromotedAt: null, summary: null };
    await store.append({ ...base, id: 'ct-old', sessionId: 'ses-old', turnIndex: 0, goal: 'old', answer: 'old', createdAt: old });
    await store.append({ ...base, id: 'ct-new', sessionId: 'ses-new', turnIndex: 0, goal: 'new', answer: 'new', createdAt: recent });
    const purged = await store.purgeSessions({ olderThanDays: 7 });
    assert.equal(purged, 1);
    const remaining = await store.get('ct-new');
    assert.ok(remaining);
    const gone = await store.get('ct-old');
    assert.equal(gone, null);
    await store.close();
  });

  test('get returns null for missing id', async () => {
    const store = await createStore();
    const got = await store.get('ct-missing');
    assert.equal(got, null);
    await store.close();
  });

  test('listSession returns empty for unknown session', async () => {
    const store = await createStore();
    const turns = await store.listSession('ses-unknown');
    assert.deepEqual(turns, []);
    await store.close();
  });
}
