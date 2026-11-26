-- Persistent notebook sessions: one open "notebook" per chat that the bot keeps
-- "open" so follow-up questions, new sources, and typed outputs all target the
-- SAME Google NotebookLM notebook (plan: persistent notebook session).
--
-- A session is an ANCHOR for job execution: jobs carry `sessionId`/`mode` and
-- the runner addresses the session's notebook_id (and conversation_id for
-- follow-ups) instead of creating a fresh notebook per job.
--
-- Exactly one `open` session per chat is the intended steady state; `/finish`
-- (logical close) or the idle TTL sweeper move it to `closed`/`expired`. The
-- notebook itself is left in Google (v1 does NOT auto-delete it).

CREATE TABLE IF NOT EXISTS notebook_sessions (
  id TEXT PRIMARY KEY,
  chat_id INTEGER NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  notebook_id TEXT,
  notebook_title TEXT NOT NULL,
  conversation_id TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'expired')),
  created_at TEXT NOT NULL,
  last_used_at TEXT NOT NULL,
  closed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_nb_sessions_chat ON notebook_sessions(chat_id);
CREATE INDEX IF NOT EXISTS idx_nb_sessions_status ON notebook_sessions(status);
