CREATE TABLE api_keys (
  id           TEXT PRIMARY KEY,               -- ak_<16 hex>
  name         TEXT NOT NULL,                  -- user-chosen label, <= 64 chars
  key_prefix   TEXT NOT NULL,                  -- first 8 chars of the raw key (display)
  key_hash     TEXT NOT NULL UNIQUE,           -- hex(sha256(raw key))
  created_at   TEXT NOT NULL,                  -- ISO-8601 (db.now())
  last_used_at TEXT,                           -- stamped on successful verify
  revoked_at   TEXT                            -- soft revoke; NULL = active
);
