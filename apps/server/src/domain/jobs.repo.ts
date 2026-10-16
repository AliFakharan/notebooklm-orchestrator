import { randomBytes } from "node:crypto";
import type { Db } from "../db/db.js";
import type { FailureClass, Job, JobEvent, JobInput, JobStatus } from "@nlo/shared";
import { canTransition, transition } from "@nlo/shared";

/**
 * Jobs repository. Enforces the shared state machine on every status write:
 * `setStatus` validates via `canTransition` and throws on illegal moves.
 */
export class JobsRepo {
  constructor(private readonly db: Db) {}

  newId(): string {
    // Server-side generated, hex, no user input.
    return `j_${randomBytes(16).toString("hex")}`;
  }

  create(input: {
    input: JobInput;
    configSnapshot: Record<string, unknown>;
    maxAttempts?: number;
  }): Job {
    const id = this.newId();
    const now = this.db.now();
    this.db.raw
      .prepare(
        `INSERT INTO jobs (id, status, input_json, attempt, max_attempts, progress, config_snapshot_json, created_at, updated_at)
         VALUES (?, 'CREATED', ?, 0, ?, 0, ?, ?, ?)`,
      )
      .run(
        id,
        JSON.stringify(input.input),
        input.maxAttempts ?? 3,
        JSON.stringify(input.configSnapshot),
        now,
        now,
      );
    return this.getOrThrow(id);
  }

  get(id: string): Job | null {
    const row = this.db.raw.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as
      Record<string, unknown> | undefined;
    return row ? this.map(row) : null;
  }

  getOrThrow(id: string): Job {
    const j = this.get(id);
    if (!j) throw new Error(`job not found: ${id}`);
    return j;
  }

  /**
   * Transition the job to a new status. Enforces the state machine.
   * Throws on illegal transition (caller catches and returns 409).
   */
  setStatus(id: string, to: JobStatus, patch: Partial<Job> = {}): Job {
    const current = this.getOrThrow(id);
    if (!canTransition(current.status, to)) {
      throw new Error(`invalid job state transition: ${current.status} -> ${to}`);
    }
    transition(current.status, to); // throws with typed error
    const now = this.db.now();
    this.db.raw
      .prepare(
        `UPDATE jobs SET status=?, attempt=?, progress=?, progress_note=?,
           error_class=?, error_message=?, answer_markdown=?, result_provider_meta_json=?,
           account_id=?, node_id=?, updated_at=?, finished_at=?
         WHERE id=?`,
      )
      .run(
        to,
        patch.attempt ?? current.attempt,
        patch.progress ?? current.progress,
        patch.progressNote === undefined ? current.progressNote : patch.progressNote,
        patch.errorClass === undefined ? current.errorClass : patch.errorClass,
        patch.errorMessage === undefined ? current.errorMessage : patch.errorMessage,
        patch.answerMarkdown === undefined ? current.answerMarkdown : patch.answerMarkdown,
        patch.resultProviderMeta === undefined
          ? current.resultProviderMeta
            ? JSON.stringify(current.resultProviderMeta)
            : null
          : JSON.stringify(patch.resultProviderMeta),
        patch.accountId === undefined ? current.accountId : patch.accountId,
        patch.nodeId === undefined ? current.nodeId : patch.nodeId,
        now,
        ["SUCCEEDED", "FAILED", "CANCELLED"].includes(to) ? now : null,
        id,
      );
    return this.getOrThrow(id);
  }

  /** Bump attempt counter (used when re-entering WAITING_FOR_ACCOUNT). */
  nextAttempt(id: string): Job {
    this.getOrThrow(id);
    this.db.raw
      .prepare("UPDATE jobs SET attempt = attempt + 1, updated_at = ? WHERE id = ?")
      .run(this.db.now(), id);
    return this.getOrThrow(id);
  }

  setProgress(id: string, progress: number, note: string): void {
    this.db.raw
      .prepare("UPDATE jobs SET progress=?, progress_note=?, updated_at=? WHERE id=?")
      .run(Math.max(0, Math.min(100, Math.round(progress))), note, this.db.now(), id);
  }

  list(filter: {
    status?: JobStatus | JobStatus[];
    accountId?: string;
    nodeId?: string;
    limit?: number;
    offset?: number;
    search?: string;
  }): { items: Job[]; total: number } {
    const where: string[] = [];
    const params: (string | number)[] = [];
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
      where.push(`status IN (${statuses.map(() => "?").join(",")})`);
      params.push(...statuses);
    }
    if (filter.accountId) {
      where.push("account_id = ?");
      params.push(filter.accountId);
    }
    if (filter.nodeId) {
      where.push("node_id = ?");
      params.push(filter.nodeId);
    }
    if (filter.search) {
      where.push("(input_json LIKE ? OR id = ?)");
      params.push(`%${filter.search}%`, filter.search);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const limit = Math.min(filter.limit ?? 50, 200);
    const offset = filter.offset ?? 0;

    const total = Number(
      (
        this.db.raw.prepare(`SELECT COUNT(*) AS c FROM jobs ${whereSql}`).get(...params) as {
          c: number;
        }
      ).c,
    );
    const rows = (
      this.db.raw
        .prepare(`SELECT * FROM jobs ${whereSql} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
        .all(...params, limit, offset) as unknown as Record<string, unknown>[]
    ).map((r) => this.map(r));
    return { items: rows, total };
  }

  countByStatus(): Record<string, number> {
    const rows = this.db.raw
      .prepare("SELECT status, COUNT(*) AS c FROM jobs GROUP BY status")
      .all() as { status: string; c: number }[];
    const out: Record<string, number> = {};
    for (const r of rows) out[r.status] = r.c;
    return out;
  }

  appendEvent(
    jobId: string,
    type: string,
    message: string,
    data: Record<string, unknown> = {},
  ): JobEvent {
    const now = this.db.now();
    const res = this.db.raw
      .prepare("INSERT INTO job_events (job_id, at, type, message, data_json) VALUES (?,?,?,?,?)")
      .run(jobId, now, type, message, JSON.stringify(data));
    return {
      id: `evt_${Number(res.lastInsertRowid)}`,
      jobId,
      at: now,
      type,
      message,
      data,
    };
  }

  events(jobId: string, limit = 500): JobEvent[] {
    const rows = this.db.raw
      .prepare(
        "SELECT id, job_id AS jobId, at, type, message, data_json AS dataJson FROM job_events WHERE job_id = ? ORDER BY id ASC LIMIT ?",
      )
      .all(jobId, limit) as unknown as {
      id: number;
      jobId: string;
      at: string;
      type: string;
      message: string;
      dataJson: string;
    }[];
    return rows.map((r) => ({
      id: `evt_${r.id}`,
      jobId: r.jobId,
      at: r.at,
      type: r.type,
      message: r.message,
      data: JSON.parse(r.dataJson) as Record<string, unknown>,
    }));
  }

  recordAttempt(
    jobId: string,
    attempt: number,
    accountId: string | null,
    nodeId: string | null,
    startedAt: string,
    outcome: string,
    detail: Record<string, unknown>,
  ): void {
    this.db.raw
      .prepare(
        `INSERT INTO job_attempts (job_id, attempt, account_id, node_id, started_at, ended_at, outcome, detail_json)
         VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        jobId,
        attempt,
        accountId,
        nodeId,
        startedAt,
        this.db.now(),
        outcome,
        JSON.stringify(detail),
      );
  }

  attempts(jobId: string): {
    attempt: number;
    accountId: string | null;
    nodeId: string | null;
    startedAt: string;
    endedAt: string | null;
    outcome: string;
    detail: Record<string, unknown>;
  }[] {
    const rows = this.db.raw
      .prepare(
        `SELECT attempt, account_id AS accountId, node_id AS nodeId, started_at AS startedAt,
                ended_at AS endedAt, outcome, detail_json AS detailJson
         FROM job_attempts WHERE job_id = ? ORDER BY id ASC`,
      )
      .all(jobId) as unknown as {
      attempt: number;
      accountId: string | null;
      nodeId: string | null;
      startedAt: string;
      endedAt: string | null;
      outcome: string;
      detailJson: string;
    }[];
    return rows.map((r) => ({
      attempt: r.attempt,
      accountId: r.accountId,
      nodeId: r.nodeId,
      startedAt: r.startedAt,
      endedAt: r.endedAt,
      outcome: r.outcome,
      detail: JSON.parse(r.detailJson) as Record<string, unknown>,
    }));
  }

  /** On restart: all in-flight jobs are reset to QUEUED. Returns affected ids. */
  recoverInFlight(): string[] {
    const rows = this.db.raw
      .prepare(
        `SELECT id FROM jobs WHERE status IN
          ('VALIDATING','QUEUED','WAITING_FOR_ACCOUNT','WAITING_FOR_PROXY','RUNNING','RETRY_WAIT','CANCEL_REQUESTED')`,
      )
      .all() as { id: string }[];
    const now = this.db.now();
    for (const r of rows) {
      this.db.raw
        .prepare(
          "UPDATE jobs SET status='QUEUED', progress_note='reset after restart', updated_at=? WHERE id=?",
        )
        .run(now, r.id);
      this.appendEvent(r.id, "restart_recover", "job reset to QUEUED after application restart");
    }
    return rows.map((r) => r.id);
  }

  private map(row: Record<string, unknown>): Job {
    const input = JSON.parse(row.input_json as string) as JobInput;
    const status = row.status as JobStatus;
    return {
      id: row.id as string,
      status,
      input,
      accountId: (row.account_id as string | null) ?? null,
      nodeId: (row.node_id as string | null) ?? null,
      attempt: row.attempt as number,
      maxAttempts: row.max_attempts as number,
      progress: row.progress as number,
      progressNote: (row.progress_note as string | null) ?? null,
      errorClass: (row.error_class as FailureClass | null) ?? null,
      errorMessage: (row.error_message as string | null) ?? null,
      answerMarkdown: (row.answer_markdown as string | null) ?? null,
      resultProviderMeta: (row.result_provider_meta_json
        ? JSON.parse(row.result_provider_meta_json as string)
        : null) as Record<string, unknown> | null,
      configSnapshot: JSON.parse(row.config_snapshot_json as string) as Record<string, unknown>,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      finishedAt: (row.finished_at as string | null) ?? null,
    };
  }
}
