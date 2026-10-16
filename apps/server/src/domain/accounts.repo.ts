import { randomUUID } from "node:crypto";
import type { Db } from "../db/db.js";
import type { AccountStatus } from "@nlo/shared";

export interface AccountRow {
  id: string;
  label: string;
  displayEmail: string;
  status: AccountStatus;
  enabled: boolean;
  authSecretRef: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  quotaNote: string | null;
  /** The provider profile bound to this account's auth session, if any. */
  authProfile: string | null;
  /** Last time the account's session was verified live (mirror of auth_sessions). */
  lastVerifiedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

const VALID_STATUS = ["ACTIVE", "DEGRADED", "RATE_LIMITED", "AUTH_REQUIRED", "DISABLED", "UNKNOWN"];

export class AccountsRepo {
  constructor(private readonly db: Db) {}

  create(input: {
    label: string;
    displayEmail?: string;
    authSecretRef?: string | null;
  }): AccountRow {
    const label = input.label.trim();
    if (!label) throw new Error("label is required");
    const dup = this.db.raw.prepare("SELECT 1 AS x FROM accounts WHERE label = ?").get(label);
    if (dup) throw new Error(`account label already exists: ${label}`);

    const now = this.db.now();
    const id = `acc_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.db.raw
      .prepare(
        `INSERT INTO accounts (id, label, display_email, status, enabled, auth_secret_ref, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        id,
        label,
        (input.displayEmail ?? "").trim(),
        "UNKNOWN",
        1,
        input.authSecretRef ?? null,
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): AccountRow | null {
    const row = this.db.raw.prepare("SELECT * FROM accounts WHERE id = ?").get(id);
    return row ? this.map(row) : null;
  }

  getOrThrow(id: string): AccountRow {
    const row = this.get(id);
    if (!row) throw new Error(`account not found: ${id}`);
    return row;
  }

  list(): AccountRow[] {
    const rows = this.db.raw
      .prepare("SELECT * FROM accounts ORDER BY label")
      .all() as unknown as Record<string, unknown>[];
    return rows.map((r) => this.map(r));
  }

  update(
    id: string,
    patch: Partial<
      Pick<
        AccountRow,
        | "label"
        | "displayEmail"
        | "status"
        | "enabled"
        | "authSecretRef"
        | "quotaNote"
        | "authProfile"
        | "lastVerifiedAt"
      >
    >,
  ): AccountRow {
    const current = this.getOrThrow(id);
    if (patch.status && !VALID_STATUS.includes(patch.status)) {
      throw new Error(`invalid account status: ${patch.status}`);
    }
    const next = {
      label: patch.label ?? current.label,
      displayEmail: patch.displayEmail ?? current.displayEmail,
      status: patch.status ?? current.status,
      enabled: patch.enabled ?? current.enabled,
      authSecretRef:
        patch.authSecretRef === undefined ? current.authSecretRef : patch.authSecretRef,
      quotaNote: patch.quotaNote === undefined ? current.quotaNote : patch.quotaNote,
      authProfile: patch.authProfile === undefined ? current.authProfile : patch.authProfile,
      lastVerifiedAt:
        patch.lastVerifiedAt === undefined ? current.lastVerifiedAt : patch.lastVerifiedAt,
    };
    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE accounts SET label=?, display_email=?, status=?, enabled=?, auth_secret_ref=?, quota_note=?, auth_profile=?, last_verified_at=?, updated_at=?
         WHERE id=?`,
      )
      .run(
        next.label,
        next.displayEmail,
        next.status,
        next.enabled ? 1 : 0,
        next.authSecretRef,
        next.quotaNote,
        next.authProfile,
        next.lastVerifiedAt,
        now,
        id,
      );
    return this.getOrThrow(id);
  }

  delete(id: string): boolean {
    const res = this.db.raw.prepare("DELETE FROM accounts WHERE id = ?").run(id);
    return Number(res.changes) > 0;
  }

  recordSuccess(id: string): void {
    this.db.raw
      .prepare("UPDATE accounts SET last_success_at=?, updated_at=? WHERE id=?")
      .run(this.db.now(), this.db.now(), id);
  }

  recordError(id: string, error: string, status: AccountStatus): void {
    this.db.raw
      .prepare("UPDATE accounts SET last_error=?, status=?, updated_at=? WHERE id=?")
      .run(error.slice(0, 2000), status, this.db.now(), id);
  }

  /** Accounts eligible for automatic selection: enabled and not disabled/auth-required. */
  eligible(): AccountRow[] {
    return this.list().filter(
      (a) => a.enabled && a.status !== "DISABLED" && a.status !== "AUTH_REQUIRED",
    );
  }

  private map(row: Record<string, unknown>): AccountRow {
    return {
      id: row.id as string,
      label: row.label as string,
      displayEmail: row.display_email as string,
      status: row.status as AccountStatus,
      enabled: Boolean(row.enabled),
      authSecretRef: (row.auth_secret_ref as string | null) ?? null,
      lastSuccessAt: (row.last_success_at as string | null) ?? null,
      lastError: (row.last_error as string | null) ?? null,
      quotaNote: (row.quota_note as string | null) ?? null,
      authProfile: (row.auth_profile as string | null) ?? null,
      lastVerifiedAt: (row.last_verified_at as string | null) ?? null,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
    };
  }
}
