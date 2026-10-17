-- 0003: mark one account as the default job-selection preference.
-- At most one row may carry the flag; enforced in AccountsRepo.setDefault
-- (SQLite has no partial unique index with a value filter that is portable
-- here, so the repository is the enforcement point).
ALTER TABLE accounts ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0
  CHECK (is_default IN (0, 1));
