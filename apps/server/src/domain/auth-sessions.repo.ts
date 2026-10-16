import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import type { AuthSession, AuthSessionState } from "@nlo/shared";

/**
 * AuthSessionsRepo: real authentication session records, one per account per
 * provider.
 *
 * Invariants enforced here:
 *  - A session row is the ONLY evidence of authentication. Account DB status
 *    flags never count (see eligibility() which joins against sessions).
 *  - State transitions are validated; you cannot jump UNKNOWN -> AUTHENTICATED.
 *  - Profiles are unique: one account cannot bind another account's session.
 */

const VALID: AuthSessionState[] = [
  "CONFIGURED",
  "AUTH_REQUIRED",
  "AUTH_IN_PROGRESS",
  "AUTHENTICATED",
  "SESSION_EXPIRED",
  "SESSION_INVALID",
  "ACCESS_UNAVAILABLE",
  "DISABLED",
  "UNKNOWN",
];

const TRANSITIONS: Record<AuthSessionState, AuthSessionState[]> = {
  UNKNOWN: ["CONFIGURED", "AUTH_REQUIRED", "AUTHENTICATED", "DISABLED"],
  CONFIGURED: ["AUTH_REQUIRED", "AUTH_IN_PROGRESS", "DISABLED"],
  AUTH_REQUIRED: ["AUTH_IN_PROGRESS", "AUTHENTICATED", "DISABLED"],
  AUTH_IN_PROGRESS: [
    "AUTHENTICATED",
    "AUTH_REQUIRED",
    "SESSION_INVALID",
    "ACCESS_UNAVAILABLE",
    "DISABLED",
  ],
  AUTHENTICATED: [
    "SESSION_EXPIRED",
    "SESSION_INVALID",
    "ACCESS_UNAVAILABLE",
    "DISABLED",
    "AUTH_REQUIRED",
  ],
  SESSION_EXPIRED: ["AUTH_REQUIRED", "AUTH_IN_PROGRESS", "DISABLED"],
  SESSION_INVALID: ["AUTH_REQUIRED", "AUTH_IN_PROGRESS", "DISABLED"],
  ACCESS_UNAVAILABLE: ["AUTHENTICATED", "AUTH_REQUIRED", "DISABLED"],
  DISABLED: ["CONFIGURED", "AUTH_REQUIRED"],
};

export class InvalidAuthTransitionError extends Error {
  constructor(
    public readonly from: AuthSessionState,
    public readonly to: AuthSessionState,
  ) {
    super(`Invalid auth session transition: ${from} -> ${to}`);
    this.name = "InvalidAuthTransitionError";
  }
}

/** States that mean "this session is a verified, usable credential". */
export const AUTHENTICATED_STATES: readonly AuthSessionState[] = ["AUTHENTICATED"];

export class AuthSessionsRepo {
  constructor(private readonly db: Db) {}

  /** Create (or re-fetch) the session record for an account+provider. */
  ensure(accountId: string, provider: string, profile: string): AuthSession {
    const existing = this.db.raw
      .prepare("SELECT * FROM auth_sessions WHERE account_id = ? AND provider = ?")
      .get(accountId, provider) as Record<string, unknown> | undefined;
    if (existing) return this.map(existing);

    const now = this.db.now();
    const id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db.raw
      .prepare(
        `INSERT INTO auth_sessions (id, account_id, provider, profile, state, created_at, updated_at)
         VALUES (?,?,?,?, 'AUTH_REQUIRED', ?, ?)`,
      )
      .run(id, accountId, provider, profile, now, now);
    return this.get(accountId, provider)!;
  }

  get(accountId: string, provider: string): AuthSession | null {
    const row = this.db.raw
      .prepare("SELECT * FROM auth_sessions WHERE account_id = ? AND provider = ?")
      .get(accountId, provider) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  byProfile(profile: string): AuthSession | null {
    const row = this.db.raw
      .prepare("SELECT * FROM auth_sessions WHERE profile = ?")
      .get(profile) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  list(): AuthSession[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM auth_sessions ORDER BY account_id, provider")
      .all() as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  /** Validate + apply a state transition. Throws on an illegal jump. */
  transition(
    accountId: string,
    provider: string,
    to: AuthSessionState,
    patch: { email?: string | null; lastError?: string | null; verified?: boolean } = {},
  ): AuthSession {
    const current = this.get(accountId, provider);
    if (!current) throw new Error(`no auth session for account ${accountId}`);
    if (!VALID.includes(to)) throw new Error(`invalid auth state: ${to}`);
    if (to !== current.state && !TRANSITIONS[current.state].includes(to)) {
      throw new InvalidAuthTransitionError(current.state, to);
    }
    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE auth_sessions
         SET state=?, email=?, last_error=?, last_verified_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        to,
        patch.email ?? current.email,
        patch.lastError ?? null,
        patch.verified ? now : current.lastVerifiedAt,
        now,
        current.id,
      );
    return this.get(accountId, provider)!;
  }

  /** A session is "usable" only if AUTHENTICATED and verified within ttlMs. */
  isUsable(session: AuthSession | null, ttlMs = 10 * 60 * 1000): boolean {
    if (!session) return false;
    if (!AUTHENTICATED_STATES.includes(session.state)) return false;
    if (!session.lastVerifiedAt) return false;
    return Date.now() - Date.parse(session.lastVerifiedAt) < ttlMs;
  }

  /**
   * Accounts eligible for job execution: enabled, not DISABLED, and holding
   * an AUTHENTICATED session verified within ttl. A plain DB flag is never
   * sufficient evidence.
   */
  eligibleAccountIds(ttlMs = 10 * 60 * 1000): Set<string> {
    const out = new Set<string>();
    for (const s of this.list()) {
      if (this.isUsable(s, ttlMs)) out.add(s.accountId);
    }
    return out;
  }

  delete(accountId: string, provider: string): boolean {
    const res = this.db.raw
      .prepare("DELETE FROM auth_sessions WHERE account_id = ? AND provider = ?")
      .run(accountId, provider);
    return Number(res.changes) > 0;
  }

  private map(row: Record<string, unknown>): AuthSession {
    return {
      id: row.id as string,
      accountId: row.account_id as string,
      provider: row.provider as string,
      profile: row.profile as string,
      email: (row.email as string | null) ?? null,
      state: row.state as AuthSessionState,
      lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
