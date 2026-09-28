// host/memory/conversation-context.mjs
import { randomUUID } from 'node:crypto';

function truncate(text, max) {
  if (!text || text.length <= max) return text;
  return text.slice(0, max);
}

export function createConversationContext({
  store,
  engine,
  fleetApi,
  maxRecentTurns = 6,
  maxTotalTurns = 20,
  compactionStrategy = 'summarise',
  answerMaxChars = 500,
  events = null,
  logger = console,
} = {}) {
  async function summarise(turns) {
    const text = turns.map(t => `User: ${t.goal}\nAgent: ${t.answer ?? '(no answer)'}`).join('\n\n');
    const prompt = `Summarise the following conversation history into a concise paragraph. Preserve key decisions, requests, and results. Do not add new information.\n\n${text}`;
    const response = await fleetApi.executePrompt({ member_name: 'doer', prompt });
    const summary = typeof response === 'string' ? response : (response?.content ?? []).map(p => p.text ?? '').join('\n');
    return summary;
  }

  async function runDecay(turns) {
    const now = new Date();
    for (const turn of turns) {
      const r = engine.computeRetrievability(turn, now);
      const newState = engine.computeState(r);
      if (newState !== turn.state || Math.abs(r - turn.retrievalStrength) > 0.01) {
        await store.update(turn.id, { retrievalStrength: r, state: newState });
        turn.retrievalStrength = r;
        turn.state = newState;
      }
    }
  }

  return {
    mode: 'store',
    maxRecentTurns,

    async open() { await store.open(); },
    async close() { await store.close(); },

    async forPrompt(sessionId) {
      if (!sessionId) return [];
      const allTurns = await store.listSession(sessionId, { states: ['active', 'dormant'] });
      if (allTurns.length === 0) return [];

      await runDecay(allTurns);

      const visible = allTurns.filter(t => t.state === 'active' || t.state === 'dormant');
      if (visible.length === 0) return [];

      events?.emit('memory:conversation:recall', { sessionId, turnCount: visible.length });

      if (visible.length <= maxRecentTurns) {
        return visible.map(t => ({ role: 'turn', goal: t.goal, answer: t.answer }));
      }

      const older = visible.slice(0, visible.length - maxRecentTurns);
      const recent = visible.slice(-maxRecentTurns);

      if (compactionStrategy === 'summarise') {
        try {
          const summaryText = await summarise(older);
          events?.emit('memory:conversation:compact', { sessionId, strategy: 'summarise', survivingTurns: recent.length });
          return [
            { role: 'summary', text: summaryText },
            ...recent.map(t => ({ role: 'turn', goal: t.goal, answer: t.answer })),
          ];
        } catch (err) {
          logger.warn?.(`[memory/conversation] summarise failed, falling back to sliding-window: ${err?.message ?? err}`);
        }
      }

      events?.emit('memory:conversation:compact', { sessionId, strategy: 'sliding-window', survivingTurns: recent.length });
      return recent.map(t => ({ role: 'turn', goal: t.goal, answer: t.answer }));
    },

    async recordTurn(sessionId, { goal, answer, status }) {
      if (!sessionId) return null;
      const existing = await store.listSession(sessionId);
      const turnIndex = existing.length;

      const fields = {
        goal,
        answer: truncate(answer, answerMaxChars),
        status: status ?? 'completed',
        createdAt: new Date().toISOString(),
        retrievalStrength: 1.0,
        stability: 1.0,
        state: 'active',
        lastPromotedAt: new Date().toISOString(),
        summary: null,
      };

      let turn;
      if (maxTotalTurns && existing.length >= maxTotalTurns) {
        // Cap reached: recycle the weakest/oldest turn's row instead of appending
        // a new one, so the total turn count for the session never exceeds
        // maxTotalTurns. store.update() only persists goal/answer/status/
        // retrievalStrength/stability/state/lastPromotedAt/summary — it does
        // NOT persist turnIndex or sessionId — so those are intentionally left
        // out of the patch, and the tie-break below uses lastPromotedAt (which
        // IS persisted and is set fresh on every recordTurn call) instead of
        // turnIndex (which would stay frozen at its original value and always
        // pick the same row, silently dropping turns and corrupting order).
        const sorted = [...existing].sort(
          (a, b) => (a.retrievalStrength - b.retrievalStrength) || (new Date(a.lastPromotedAt) - new Date(b.lastPromotedAt))
        );
        const oldest = sorted[0];
        await store.update(oldest.id, fields);
        turn = { id: oldest.id, sessionId, turnIndex: oldest.turnIndex, ...fields };
      } else {
        turn = { id: `ct-${randomUUID().slice(0, 12)}`, sessionId, turnIndex, ...fields };
        await store.append(turn);
      }

      events?.emit('memory:conversation:store', { sessionId, turnId: turn.id });
      return turn;
    },

    async promoteTurn(sessionId, turnId) {
      const turn = await store.get(turnId);
      if (!turn || turn.sessionId !== sessionId) return null;
      const patch = engine.processReview(turn, 3);
      return store.update(turnId, patch);
    },
  };
}
