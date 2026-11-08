import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Db } from "../db/db.js";
import type { ApiKeyInfo } from "@nlo/shared";

/**
 * API keys for machine-to-machine access to the job surface.
 *
 * The raw key is returned exactly once, by `create`. Only `hex(sha256(raw))`
 * is stored, so list/verify never expose the key itself or its hash.
 */
export class ApiKeyRepo {
  constructor(private readonly db: Db) {}

  create(name: string): {
    id: string;
    raw: string;
    name: string;
    prefix: string;
    createdAt: string;
  } {
    const raw = "nlo_" + randomBytes(32).toString("base64url");
    const id = `ak_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const now = this.db.now();
    this.db.raw
      .prepare(
        "INSERT INTO api_keys (id, name, key_prefix, key_hash, created_at) VALUES (?,?,?,?,?)",
      )
      .run(id, name, raw.slice(0, 8), this.hash(raw), now);
    return { id, raw, name, prefix: raw.slice(0, 8), createdAt: now };
  }

  list(): ApiKeyInfo[] {
    const rows = this.db.raw
      .prepare(
        "SELECT id, name, key_prefix, created_at, last_used_at, revoked_at FROM api_keys ORDER BY created_at",
      )
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  verify(rawKey: string): ApiKeyInfo | null {
    const presented = this.hash(rawKey);
    const row = this.db.raw.prepare("SELECT * FROM api_keys WHERE key_hash = ?").get(presented) as
      Record<string, unknown> | undefined;
    if (!row) return null;
    // Same timing-safe comparison pattern as admin-auth.ts (hash both sides,
    // then timingSafeEqual) so a wrong key is not distinguishable by timing.
    if (!timingSafeEq(presented, row.key_hash as string)) return null;
    if (row.revoked_at !== null) return null;
    const now = this.db.now();
    this.db.raw
      .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
      .run(now, row.id as string);
    return this.map({ ...row, last_used_at: now });
  }

  /** Soft-revokes the key. True if it was active; idempotent. */
  revoke(id: string): boolean {
    const res = this.db.raw
      .prepare("UPDATE api_keys SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL")
      .run(this.db.now(), id);
    return Number(res.changes) > 0;
  }

  private hash(rawKey: string): string {
    return createHash("sha256").update(rawKey, "utf8").digest("hex");
  }

  private map(row: Record<string, unknown>): ApiKeyInfo {
    return {
      id: row.id as string,
      name: row.name as string,
      prefix: row.key_prefix as string,
      createdAt: row.created_at as string,
      lastUsedAt: (row.last_used_at as string | null) ?? null,
      revokedAt: (row.revoked_at as string | null) ?? null,
    };
  }
}

function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}
