-- 0004: an auth session profile is scoped PER ACCOUNT, not globally.
--
-- Bug: 0002 declared `profile TEXT NOT NULL UNIQUE`, which globally limited
-- the whole system to ONE account using a profile (every account defaults to
-- "default", so creating a second account crashed the first login).
--
-- Multi-account support requires one profile per (account, provider), so the
-- constraint must be composite. SQLite cannot alter a UNIQUE constraint in
-- place, so the table is rebuilt (3.35+ compatible, no data migration of
-- values is required — the schema is shape-only).
CREATE TABLE IF NOT EXISTS auth_sessions_new (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'notebooklm-py',
  profile TEXT NOT NULL,
  email TEXT,
  state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN (
      'CONFIGURED','AUTH_REQUIRED','AUTH_IN_PROGRESS','AUTHENTICATED',
      'SESSION_EXPIRED','SESSION_INVALID','ACCESS_UNAVAILABLE','DISABLED','UNKNOWN'
    )),
  last_verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (account_id, provider, profile)
);

INSERT OR IGNORE INTO auth_sessions_new
  (id, account_id, provider, profile, email, state, last_verified_at, last_error, created_at, updated_at)
  SELECT id, account_id, provider, profile, email, state, last_verified_at, last_error, created_at, updated_at
    FROM auth_sessions
   WHERE account_id IN (SELECT id FROM accounts);

DROP TABLE auth_sessions;
ALTER TABLE auth_sessions_new RENAME TO auth_sessions;

CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id);
