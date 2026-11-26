import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.js";
import type { NotebookSession, NotebookSessionStatus } from "@nlo/shared";

/**
 * NotebookSessionsRepo: persistent notebook sessions (one open notebook per
 * chat). This is the ANCHOR for session-scoped jobs: a job carrying
 * `sessionId`/`mode` addresses the session's notebook_id (and conversation_id
 * for follow-ups) instead of creating a fresh notebook.
 *
 * Invariants:
 *  - A session id is server-generated (`ns_<hex>`), never user input.
 *  - `touch` refreshes last_used_at and may patch the anchor fields (the runner
 *    writes the notebook_id/conversation_id/account_id back after a job).
 *  - `close` (finish) and `expire` are one-way: an open session moves to
 *    closed/expired; anything already terminal is left untouched (idempotent).
 */
export class NotebookSessionsRepo {
  constructor(private readonly db: Db) {}

  newId(): string {
    return `ns_${randomBytes(16).toString("hex")}`;
  }

  /**
   * Create a new OPEN session for a chat. `notebookTitle` is the stable
   * title the first job's notebook is created with; `notebookId` is unknown
   * until that job succeeds (the runner patches it via `touch`).
   */
  create(input: { chatId: number; notebookTitle: string }): NotebookSession {
    const id = this.newId();
    const now = this.db.now();
    this.db.raw
      .prepare(
        `INSERT INTO notebook_sessions (id, chat_id, notebook_title, status, created_at, last_used_at)
         VALUES (?, ?, ?, 'open', ?, ?)`,
      )
      .run(id, input.chatId, input.notebookTitle, now, now);
    return this.getOrThrow(id);
  }

  get(id: string): NotebookSession | null {
    const row = this.db.raw
      .prepare("SELECT * FROM notebook_sessions WHERE id = ?")
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  getOrThrow(id: string): NotebookSession {
    const s = this.get(id);
    if (!s) throw new Error(`notebook session not found: ${id}`);
    return s;
  }

  /** The chat's single open session, or null (one open session per chat). */
  getOpenByChat(chatId: number): NotebookSession | null {
    const row = this.db.raw
      .prepare("SELECT * FROM notebook_sessions WHERE chat_id = ? AND status = 'open'")
      .get(chatId) as Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  /**
   * Refresh the idle TTL and patch anchor fields. `patch` fields apply only
   * when provided (undefined = keep current). Does not change status.
   */
  touch(
    id: string,
    patch: {
      notebookId?: string | null;
      conversationId?: string | null;
      accountId?: string | null;
    } = {},
  ): NotebookSession {
    const current = this.getOrThrow(id);
    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE notebook_sessions
         SET last_used_at=?,
             notebook_id = COALESCE(?, notebook_id),
             conversation_id = ?,
             account_id = COALESCE(?, account_id)
         WHERE id=?`,
      )
      .run(
        now,
        patch.notebookId === undefined ? null : patch.notebookId,
        patch.conversationId === undefined ? current.conversationId : patch.conversationId,
        patch.accountId === undefined ? null : patch.accountId,
        id,
      );
    return this.getOrThrow(id);
  }

  /** Logical close (`/finish`). Idempotent: a terminal session is unchanged. */
  close(id: string): NotebookSession {
    return this.terminalize(id, "closed");
  }

  /** Idle-TTL expiry. Idempotent: a terminal session is unchanged. */
  expire(id: string): NotebookSession {
    return this.terminalize(id, "expired");
  }

  /**
   * Expire every OPEN session idle longer than `ttlMs`. Returns the ids that
   * were expired (already-terminal rows are ignored).
   */
  expireStale(ttlMs: number): string[] {
    const cutoff = new Date(Date.now() - ttlMs).toISOString();
    const rows = this.db.raw
      .prepare(
        "SELECT id FROM notebook_sessions WHERE status = 'open' AND last_used_at < ?",
      )
      .all(cutoff) as { id: string }[];
    const now = this.db.now();
    for (const r of rows) {
      this.db.raw
        .prepare(
          "UPDATE notebook_sessions SET status='expired', closed_at=? WHERE id=? AND status='open'",
        )
        .run(now, r.id);
    }
    return rows.map((r) => r.id);
  }

  private terminalize(id: string, to: Extract<NotebookSessionStatus, "closed" | "expired">): NotebookSession {
    const current = this.getOrThrow(id);
    if (current.status === "open") {
      const now = this.db.now();
      this.db.raw
        .prepare("UPDATE notebook_sessions SET status=?, closed_at=? WHERE id=?")
        .run(to, now, id);
    }
    return this.getOrThrow(id);
  }

  private map(row: Record<string, unknown>): NotebookSession {
    return {
      id: row.id as string,
      chatId: row.chat_id as number,
      accountId: (row.account_id as string | null) ?? null,
      notebookId: (row.notebook_id as string | null) ?? null,
      notebookTitle: row.notebook_title as string,
      conversationId: (row.conversation_id as string | null) ?? null,
      status: row.status as NotebookSessionStatus,
      createdAt: row.created_at as string,
      lastUsedAt: row.last_used_at as string,
      closedAt: (row.closed_at as string | null) ?? null,
    };
  }
}
