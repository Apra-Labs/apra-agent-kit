// host/memory/conversation-store/sqlite.mjs
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS conversation_turns (
  id                  TEXT PRIMARY KEY,
  session_id          TEXT NOT NULL,
  turn_index          INTEGER NOT NULL,
  goal                TEXT NOT NULL,
  answer              TEXT,
  status              TEXT NOT NULL DEFAULT 'active',
  created_at          TEXT NOT NULL,
  retrieval_strength  REAL NOT NULL DEFAULT 1.0,
  stability           REAL NOT NULL DEFAULT 1.0,
  state               TEXT NOT NULL DEFAULT 'active',
  last_promoted_at    TEXT,
  summary             TEXT
);
CREATE INDEX IF NOT EXISTS idx_ct_session ON conversation_turns(session_id);
CREATE INDEX IF NOT EXISTS idx_ct_state   ON conversation_turns(state);
`;

function toRow(turn) {
  return {
    id: turn.id, session_id: turn.sessionId, turn_index: turn.turnIndex,
    goal: turn.goal, answer: turn.answer ?? null, status: turn.status,
    created_at: turn.createdAt, retrieval_strength: turn.retrievalStrength,
    stability: turn.stability, state: turn.state,
    last_promoted_at: turn.lastPromotedAt ?? null, summary: turn.summary ?? null,
  };
}

function fromRow(row) {
  return {
    id: row.id, sessionId: row.session_id, turnIndex: row.turn_index,
    goal: row.goal, answer: row.answer, status: row.status,
    createdAt: row.created_at, retrievalStrength: row.retrieval_strength,
    stability: row.stability, state: row.state,
    lastPromotedAt: row.last_promoted_at, summary: row.summary,
  };
}

export function createConversationSqliteStore({ dbPath }) {
  if (!dbPath) throw new Error('createConversationSqliteStore requires dbPath');
  let db = null;

  const ensureOpen = () => { if (!db) throw new Error('conversation store is not open'); };

  return {
    async open() {
      if (db) return;
      fs.mkdirSync(path.dirname(dbPath), { recursive: true });
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA journal_mode = WAL');
      db.exec('PRAGMA busy_timeout = 5000');
      db.exec(SCHEMA);
    },

    async close() {
      if (!db) return;
      db.close();
      db = null;
    },

    async append(turn) {
      ensureOpen();
      const r = toRow(turn);
      db.prepare(
        `INSERT INTO conversation_turns (id, session_id, turn_index, goal, answer, status, created_at, retrieval_strength, stability, state, last_promoted_at, summary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(r.id, r.session_id, r.turn_index, r.goal, r.answer, r.status, r.created_at, r.retrieval_strength, r.stability, r.state, r.last_promoted_at, r.summary);
    },

    async get(id) {
      ensureOpen();
      const row = db.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(id);
      return row ? fromRow(row) : null;
    },

    async update(id, patch) {
      ensureOpen();
      const row = db.prepare('SELECT * FROM conversation_turns WHERE id = ?').get(id);
      if (!row) throw new Error(`conversation turn ${id} not found`);
      const existing = fromRow(row);
      const next = { ...existing, ...patch };
      const nr = toRow(next);
      db.prepare(
        `UPDATE conversation_turns SET goal=?, answer=?, status=?, retrieval_strength=?, stability=?, state=?, last_promoted_at=?, summary=? WHERE id=?`
      ).run(nr.goal, nr.answer, nr.status, nr.retrieval_strength, nr.stability, nr.state, nr.last_promoted_at, nr.summary, id);
      return next;
    },

    async listSession(sessionId, { states, limit } = {}) {
      ensureOpen();
      let sql = 'SELECT * FROM conversation_turns WHERE session_id = ?';
      const params = [sessionId];
      if (states?.length) {
        sql += ` AND state IN (${states.map(() => '?').join(',')})`;
        params.push(...states);
      }
      sql += ' ORDER BY turn_index ASC';
      if (limit) { sql += ' LIMIT ?'; params.push(limit); }
      return db.prepare(sql).all(...params).map(fromRow);
    },

    async purgeSessions({ olderThanDays } = {}) {
      ensureOpen();
      if (!olderThanDays) return 0;
      const cutoff = new Date(Date.now() - olderThanDays * 24 * 60 * 60 * 1000).toISOString();
      const { changes } = db.prepare('DELETE FROM conversation_turns WHERE created_at < ?').run(cutoff);
      return Number(changes);
    },
  };
}
