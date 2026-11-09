-- Session Keeper check history: one row per background keeper verification
-- poke (and each live check). Pruned to a 30-day rolling window on insert.
CREATE TABLE IF NOT EXISTS session_checks (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL,
  checked_at TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('ok','auth_failed','infra_error')),
  detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_session_checks_account ON session_checks (account_id, checked_at);
