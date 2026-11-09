import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";

/**
 * SessionChecksRepo: rolling history of background session-keeper checks.
 *
 * One row per verification poke. Kept purely for observability (why did the
 * keeper alert / not alert?). Rows are pruned to a 30-day window on every
 * insert so the table cannot grow unbounded.
 */

export type SessionCheckOutcome = "ok" | "auth_failed" | "infra_error";

export interface SessionCheck {
  id: string;
  accountId: string;
  checkedAt: string;
  outcome: SessionCheckOutcome;
  detail: string | null;
}

const RETENTION_MS = 30 * 24 * 3600 * 1000;

export class SessionChecksRepo {
  constructor(private readonly db: Db) {}

  /** Insert a check row and prune anything older than the retention window. */
  record(accountId: string, outcome: SessionCheckOutcome, detail: string | null): void {
    const now = this.db.now();
    const id = `chk_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db.raw
      .prepare(
        `INSERT INTO session_checks (id, account_id, checked_at, outcome, detail)
         VALUES (?,?,?,?,?)`,
      )
      .run(id, accountId, now, outcome, detail);
    // ISO-8601 strings sort chronologically, so a plain < comparison prunes
    // rows older than the cutoff.
    this.db.raw
      .prepare("DELETE FROM session_checks WHERE checked_at < ?")
      .run(new Date(Date.now() - RETENTION_MS).toISOString());
  }

  /** Most-recent-first check history for one account (for debugging). */
  listForAccount(accountId: string, limit = 50): SessionCheck[] {
    const rows = this.db.raw
      .prepare(
        `SELECT * FROM session_checks WHERE account_id = ?
         ORDER BY checked_at DESC, id DESC LIMIT ?`,
      )
      .all(accountId, limit) as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  private map(row: Record<string, unknown>): SessionCheck {
    return {
      id: row.id as string,
      accountId: row.account_id as string,
      checkedAt: row.checked_at as string,
      outcome: row.outcome as SessionCheckOutcome,
      detail: (row.detail as string | null) ?? null,
    };
  }
}
