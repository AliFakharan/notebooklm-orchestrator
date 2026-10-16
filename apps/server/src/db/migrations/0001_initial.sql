-- Initial schema: accounts, proxy nodes + health, jobs, events, artifacts, secrets, settings

CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  label TEXT NOT NULL UNIQUE,
  display_email TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'UNKNOWN'
    CHECK (status IN ('ACTIVE','DEGRADED','RATE_LIMITED','AUTH_REQUIRED','DISABLED','UNKNOWN')),
  enabled INTEGER NOT NULL DEFAULT 1,
  auth_secret_ref TEXT,
  last_success_at TEXT,
  last_error TEXT,
  quota_note TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_nodes (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  server TEXT NOT NULL,
  port INTEGER NOT NULL CHECK (port BETWEEN 1 AND 65535),
  uuid_secret_ref TEXT NOT NULL,
  transport TEXT NOT NULL CHECK (transport IN ('tcp','ws','grpc')),
  security TEXT NOT NULL CHECK (security IN ('none','tls','reality')),
  sni TEXT,
  ws_host TEXT,
  ws_path TEXT,
  pbk TEXT,
  sid TEXT,
  spx TEXT,
  flow TEXT,
  encryption TEXT,
  alpn TEXT,
  extra_json TEXT NOT NULL DEFAULT '{}',
  enabled INTEGER NOT NULL DEFAULT 1,
  priority INTEGER NOT NULL DEFAULT 100,
  preferred INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS proxy_health (
  node_id TEXT PRIMARY KEY REFERENCES proxy_nodes(id) ON DELETE CASCADE,
  last_checked_at TEXT,
  ok INTEGER NOT NULL DEFAULT 0,
  egress_ip TEXT,
  latency_ms INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS proxy_health_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  node_id TEXT NOT NULL REFERENCES proxy_nodes(id) ON DELETE CASCADE,
  checked_at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  egress_ip TEXT,
  latency_ms INTEGER,
  error TEXT
);

CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  input_json TEXT NOT NULL,
  account_id TEXT REFERENCES accounts(id) ON DELETE SET NULL,
  node_id TEXT REFERENCES proxy_nodes(id) ON DELETE SET NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  progress INTEGER NOT NULL DEFAULT 0,
  progress_note TEXT,
  error_class TEXT,
  error_message TEXT,
  answer_markdown TEXT,
  result_provider_meta_json TEXT,
  config_snapshot_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_jobs_status ON jobs(status);
CREATE INDEX IF NOT EXISTS idx_jobs_created ON jobs(created_at DESC);

CREATE TABLE IF NOT EXISTS job_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_job_events_job ON job_events(job_id, id);

CREATE TABLE IF NOT EXISTS job_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt INTEGER NOT NULL,
  account_id TEXT,
  node_id TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  outcome TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  media_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('provider','application')),
  storage_key TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_artifacts_job ON artifacts(job_id);

CREATE TABLE IF NOT EXISTS secrets (
  ref TEXT PRIMARY KEY,
  ciphertext BLOB NOT NULL,
  nonce BLOB NOT NULL,
  tag BLOB NOT NULL,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
