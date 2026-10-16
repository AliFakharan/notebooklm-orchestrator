-- 0002: real runtime support
--   * auth_sessions: per-account, per-provider session records (multi-account isolation)
--   * proxy diagnostics: rich health fields (target, category, evidence, timing)
--   * job provenance: notebook/source/conversation ids, operation ids, result provenance

CREATE TABLE IF NOT EXISTS auth_sessions (
  id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  provider TEXT NOT NULL DEFAULT 'notebooklm-py',
  profile TEXT NOT NULL UNIQUE,
  email TEXT,
  state TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (state IN (
      'CONFIGURED','AUTH_REQUIRED','AUTH_IN_PROGRESS','AUTHENTICATED',
      'SESSION_EXPIRED','SESSION_INVALID','ACCESS_UNAVAILABLE','DISABLED','UNKNOWN'
    )),
  last_verified_at TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_account ON auth_sessions(account_id);

-- Convenience mirror on accounts (canonical state lives in auth_sessions).
ALTER TABLE accounts ADD COLUMN auth_profile TEXT;
ALTER TABLE accounts ADD COLUMN last_verified_at TEXT;

-- Richer proxy health diagnostics (current row + history).
ALTER TABLE proxy_health ADD COLUMN started_at TEXT;
ALTER TABLE proxy_health ADD COLUMN target TEXT;
ALTER TABLE proxy_health ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN (
    'config','runtime','listener','transport','tls','upstream','auth','egress','ssrf','nbl_access','unknown'
  ));
ALTER TABLE proxy_health ADD COLUMN evidence TEXT;
ALTER TABLE proxy_health_history ADD COLUMN started_at TEXT;
ALTER TABLE proxy_health_history ADD COLUMN target TEXT;
ALTER TABLE proxy_health_history ADD COLUMN category TEXT
  CHECK (category IS NULL OR category IN (
    'config','runtime','listener','transport','tls','upstream','auth','egress','ssrf','nbl_access','unknown'
  ));
ALTER TABLE proxy_health_history ADD COLUMN evidence TEXT;

-- Job provenance + idempotency anchors.
ALTER TABLE jobs ADD COLUMN notebook_id TEXT;
ALTER TABLE jobs ADD COLUMN notebook_title TEXT;
ALTER TABLE jobs ADD COLUMN source_id TEXT;
ALTER TABLE jobs ADD COLUMN conversation_id TEXT;
ALTER TABLE jobs ADD COLUMN operation_ids_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE jobs ADD COLUMN result_provenance TEXT NOT NULL DEFAULT 'unknown'
  CHECK (result_provenance IN ('real','mock','unknown'));
