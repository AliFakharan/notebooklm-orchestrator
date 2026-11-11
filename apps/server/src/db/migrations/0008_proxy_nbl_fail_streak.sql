-- Internal quarantine bookkeeping: consecutive NBL-destination failures per
-- proxy node. Never exposed on the shared ProxyNode type.
ALTER TABLE proxy_nodes ADD COLUMN nbl_fail_streak INTEGER NOT NULL DEFAULT 0;
