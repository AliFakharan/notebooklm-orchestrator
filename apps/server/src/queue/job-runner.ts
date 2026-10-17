import { randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { backoffMs, classifyError, isRetryableError, safeName, resolveWithin } from "@nlo/shared";
import type { Job, FailureClass } from "@nlo/shared";
import type { JobsRepo } from "../domain/jobs.repo.js";
import type { AccountRow, AccountsRepo } from "../domain/accounts.repo.js";
import type { AuthSessionsRepo } from "../domain/auth-sessions.repo.js";
import type { ProxiesRepo } from "../domain/proxies.repo.js";
import { JobArchive } from "../domain/archive.js";
import { ProviderFailure, type NotebookLMProvider } from "../providers/types.js";
import type { ProxyManager } from "../proxy/proxy-manager.js";
import type { ProxyRuntime, TunnelHandle } from "../proxy/runtime.js";
import type { SecretVault } from "../secrets/vault.js";
import type { ProviderEgress } from "../proxy/egress.js";

/**
 * JobRunner: drives a single job through the state machine, coordinating
 * account selection, proxy selection (fail-closed), provider execution,
 * retry policy, and archive writes.
 *
 * Concurrency: the queue processes at most ONE job at a time by default —
 * we do not run multiple operations concurrently against one account unless
 * the provider behavior is verified (it is not, for live).
 *
 * State machine path (enforced by @nlo/shared job-state.ts):
 *   CREATED -> VALIDATING -> QUEUED -> WAITING_FOR_ACCOUNT -> WAITING_FOR_PROXY
 *            -> RUNNING -> SUCCEEDED | FAILED | NEEDS_ATTENTION | CANCELLED
 * Retry (bounded): RUNNING -> RETRY_WAIT -> WAITING_FOR_ACCOUNT (loop
 * re-selects account + proxy and runs again).
 *
 * Archive: every status change is mirrored to execution/timeline.jsonl and
 * every attempt to execution/attempts.json + errors.json (best-effort; a
 * broken archive never breaks the state machine).
 */
export interface JobRunnerDeps {
  jobs: JobsRepo;
  accounts: AccountsRepo;
  /** Real auth-session records (the ONLY evidence of a usable credential).
   *  Optional for backward-compat with older test harnesses; when present,
   *  account eligibility requires a live, verified session — never a plain
   *  DB status flag. */
  sessions?: AuthSessionsRepo;
  proxies: ProxiesRepo;
  provider: NotebookLMProvider;
  proxyManager: ProxyManager;
  runtime: ProxyRuntime;
  vault: SecretVault;
  egress: ProviderEgress;
  jobsDir: string;
  log: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
  rng?: () => number;
}

const sleepDefault = (ms: number) => new Promise((r) => setTimeout(r, ms));

const TERMINAL = ["SUCCEEDED", "FAILED", "CANCELLED"];

export class JobRunner {
  private active = new Map<string, AbortController>();

  constructor(private readonly d: JobRunnerDeps) {}

  queuedIds(): string[] {
    // Newly created jobs enter as CREATED; they are validated on first pick-up.
    return this.d.jobs.list({ status: ["CREATED", "QUEUED"], limit: 200 }).items.map((j) => j.id);
  }

  isActive(jobId: string): boolean {
    return this.active.has(jobId);
  }

  cancel(jobId: string): boolean {
    const c = this.active.get(jobId);
    if (!c) return false;
    c.abort();
    return true;
  }

  /**
   * Execute a job end-to-end. Only proceeds from CREATED (validate first) or
   * QUEUED. Errors are classified, then retried (bounded) or terminalized.
   */
  async run(jobId: string): Promise<Job> {
    const initial = this.d.jobs.getOrThrow(jobId);
    if (initial.status !== "CREATED" && initial.status !== "QUEUED") {
      return initial; // not our turn (e.g. already running in another worker)
    }

    const controller = new AbortController();
    this.active.set(jobId, controller);
    const archive = new JobArchive(this.d.jobsDir, jobId);

    try {
      if (initial.status === "CREATED") {
        // --- VALIDATING ---------------------------------------------------
        this.d.jobs.setStatus(jobId, "VALIDATING");
        this.logEvent(jobId, archive, "validate", "validating input");
        if (!this.validate(jobId, archive)) {
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId); // failed inside validate()
        }
        // Validation passed: the job is now QUEUED and ready to execute.
        this.d.jobs.setStatus(jobId, "QUEUED");
      }

      for (;;) {
        // --- select account (re-selected on every retry) -----------------
        // Note: after a RETRY_WAIT the status is ALREADY WAITING_FOR_ACCOUNT
        // (set by the retry path below); the state machine forbids a
        // WAITING_FOR_ACCOUNT -> WAITING_FOR_ACCOUNT self-transition, so we
        // only set it when coming from QUEUED (first attempt).
        if (this.d.jobs.getOrThrow(jobId).status !== "WAITING_FOR_ACCOUNT") {
          this.d.jobs.setStatus(jobId, "WAITING_FOR_ACCOUNT");
        }
        let account: AccountRow;
        try {
          account = this.selectAccount(this.d.jobs.getOrThrow(jobId));
        } catch {
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId); // selectAccount failed the job
        }
        this.logEvent(jobId, archive, "account_selected", `account ${account.label}`);

        // --- select proxy (fail-closed) ----------------------------------
        this.d.jobs.setStatus(jobId, "WAITING_FOR_PROXY");
        let handle: TunnelHandle | null = null;
        let nodeId: string | null = null;
        try {
          // selectAuto() validates (config + fresh healthy check) AND starts
          // the tunnel; it throws when no node can provide a real route.
          // When health is merely STALE (10-min TTL passed), it runs the real
          // staged check against the NotebookLM target first (self-heal), so
          // a previously-verified node keeps working without manual clicks.
          const sel = await this.d.proxyManager.selectAuto(
            this.d.jobs.getOrThrow(jobId).input.preferredNodeId,
          );
          nodeId = sel.node.id;
          handle = sel.handle;
          this.logEvent(
            jobId,
            archive,
            "proxy_selected",
            `node ${sel.node.config.name}; tunnel ${sel.handle.host}:${sel.handle.port} — ${sel.reason}`,
          );
          for (const r of sel.rejected) {
            this.logEvent(
              jobId,
              archive,
              "proxy_candidate_rejected",
              `node ${r.nodeId}: ${r.reason}`,
            );
          }
        } catch (err) {
          const msg = redact(String(err));
          this.d.jobs.setStatus(jobId, "FAILED", {
            errorClass: "proxy",
            errorMessage: `no approved proxy route available (fail-closed): ${msg}`,
          });
          this.logEvent(jobId, archive, "proxy_unavailable", msg);
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId);
        }

        // --- RUNNING -------------------------------------------------------
        const job = this.d.jobs.getOrThrow(jobId);
        this.d.jobs.setStatus(jobId, "RUNNING", { accountId: account.id, nodeId });
        this.logEvent(jobId, archive, "running", `attempt ${job.attempt + 1}`);
        const credentialRef = account.authSecretRef ?? `session:${account.id}`;
        const attemptStart = new Date().toISOString();
        const attemptNo = job.attempt + 1;

        try {
          const result = await this.d.provider.runJob({
            jobId,
            accountId: account.id,
            credentialRef,
            prompt: job.input.prompt,
            audioPath: this.audioPathInArchive(
              jobId,
              job.input.audio.originalName,
              job.input.audio.size,
            ),
            audioMediaType: job.input.audio.mediaType,
            tunnel: handle,
            egress: this.d.egress,
            signal: controller.signal,
            onProgress: (p, note) => this.d.jobs.setProgress(jobId, p, note),
          });

          const stored = result.artifacts.map((a, i) =>
            archive.storeArtifact(a.path, a.name, i + 1),
          );
          this.storeArtifacts(jobId, stored, result.artifacts);
          this.d.jobs.recordAttempt(jobId, attemptNo, account.id, nodeId, attemptStart, "ok", {
            provider: this.d.provider.name,
          });

          this.d.accounts.recordSuccess(account.id);
          const sim = result.providerMeta.simulated;
          this.d.jobs.setStatus(jobId, "SUCCEEDED", {
            answerMarkdown: result.answerMarkdown,
            resultProviderMeta: result.providerMeta,
            progress: 100,
            // Provenance is measured from the provider's own report, never
            // assumed: mock provider => "mock"; worker reports simulated
            // false => "real"; anything else => "unknown" (shown as such).
            resultProvenance: sim === true ? "mock" : sim === false ? "real" : "unknown",
          });
          if (result.answerMarkdown) archive.writeAnswer(result.answerMarkdown);
          this.logEvent(jobId, archive, "succeeded", "job completed");
          this.finalizeArchive(jobId, archive);
          return this.d.jobs.getOrThrow(jobId);
        } catch (err) {
          const outcome = await this.handleFailure(
            jobId,
            account.id,
            attemptNo,
            nodeId,
            attemptStart,
            archive,
            err,
            controller.signal.aborted,
          );
          if (outcome === "terminal") {
            this.finalizeArchive(jobId, archive);
            return this.d.jobs.getOrThrow(jobId);
          }
          // outcome === "retry": job is in RETRY_WAIT (after backoff sleep).
          this.d.jobs.nextAttempt(jobId);
          this.d.jobs.setStatus(jobId, "WAITING_FOR_ACCOUNT");
          // The loop re-selects account + proxy and runs again.
        } finally {
          if (nodeId) await this.d.runtime.stopTunnel(nodeId).catch(() => {});
        }
      }
    } catch (err) {
      this.d.log(`runner error for ${jobId}: ${redact(String(err))}`);
      try {
        const cur = this.d.jobs.getOrThrow(jobId);
        if (!TERMINAL.includes(cur.status)) {
          this.d.jobs.setStatus(jobId, "FAILED", {
            errorClass: "unknown",
            errorMessage: redact(String(err)),
          });
        }
      } catch {
        /* already terminal */
      }
      this.finalizeArchive(jobId, archive);
      return this.d.jobs.getOrThrow(jobId);
    } finally {
      this.active.delete(jobId);
    }
  }

  // ---------------------------------------------------------------------

  private validate(jobId: string, archive: JobArchive): boolean {
    const job = this.d.jobs.getOrThrow(jobId);
    if (!job.input.prompt || !job.input.prompt.trim()) {
      this.d.jobs.setStatus(jobId, "FAILED", {
        errorClass: "invalid_input",
        errorMessage: "prompt is empty",
      });
      this.logEvent(jobId, archive, "validation_failed", "prompt is empty");
      return false;
    }
    try {
      archive.init({
        prompt: job.input.prompt,
        originalAudioName: job.input.audio.size > 0 ? job.input.audio.originalName : null,
        audioMediaType: job.input.audio.size > 0 ? job.input.audio.mediaType : null,
        configSnapshot: job.configSnapshot,
        createdAt: job.createdAt,
      });
      return true;
    } catch (err) {
      this.d.jobs.setStatus(jobId, "FAILED", {
        errorClass: "invalid_input",
        errorMessage: `archive init failed: ${redact(String(err))}`,
      });
      this.logEvent(
        jobId,
        archive,
        "validation_failed",
        `archive init failed: ${redact(String(err))}`,
      );
      return false;
    }
  }

  /**
   * Choose the account that will actually serve this job.
   *
   * Rules:
   *  - A requested `preferredAccountId` is HONORED STRICTLY: if it exists but
   *    is not currently eligible (e.g. its session is not verified), the job
   *    fails with a clear auth error rather than silently switching to
   *    another account — never reuse one account's session for another job.
   *  - Otherwise the default account (when eligible) is preferred, then the
   *    most-recently-successful eligible account (deterministic tie-break).
   *  - Eligibility always means enabled + not DISABLED/AUTH_REQUIRED, and —
   *    when the sessions repo is present — holding an AUTHENTICATED session
   *    verified within the TTL. A DB flag alone is never sufficient.
   */
  private selectAccount(job: Job): AccountRow {
    const eligibleIds = this.d.sessions?.eligibleAccountIds() ?? null;
    const eligible = (a: AccountRow): boolean => {
      if (!a.enabled || a.status === "DISABLED") return false;
      // With a live session registry, the verified session is the source of
      // truth: a stale AUTH_REQUIRED flag (from an old failed job) must not
      // shadow a freshly verified login.
      if (eligibleIds !== null) return eligibleIds.has(a.id);
      // No registry (mock provider): fall back to the row flag.
      if (a.status === "AUTH_REQUIRED") return false;
      return true;
    };

    if (job.input.preferredAccountId) {
      const preferred = this.d.accounts.get(job.input.preferredAccountId);
      if (preferred && eligible(preferred)) {
        return preferred;
      }
      const why = !preferred
        ? "not found"
        : !preferred.enabled || preferred.status === "DISABLED"
          ? "not enabled / disabled"
          : eligibleIds !== null
            ? "session not verified (re-authentication required)"
            : "not enabled / disabled / auth-required";
      this.d.jobs.setStatus(job.id, "FAILED", {
        errorClass: "auth",
        errorMessage: `requested account "${preferred?.label ?? job.input.preferredAccountId}" is not usable: ${why}`,
      });
      this.d.jobs.appendEvent(job.id, "no_account", `requested account not usable: ${why}`);
      throw new Error(`requested account not usable: ${why}`);
    }

    const pool = this.d.accounts.eligible().filter(eligible);
    if (pool.length === 0) {
      this.d.jobs.setStatus(job.id, "FAILED", {
        errorClass: "auth",
        errorMessage: "no eligible google account with a verified session",
      });
      this.d.jobs.appendEvent(job.id, "no_account", "no eligible account with verified session");
      throw new Error("no eligible google account with a verified session");
    }

    const sorted = [...pool].sort((a, b) => {
      if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
      const as = a.lastSuccessAt ?? "";
      const bs = b.lastSuccessAt ?? "";
      if (as !== bs) return as < bs ? 1 : -1;
      return a.label.localeCompare(b.label);
    });
    const chosen = sorted[0];
    if (!chosen) throw new Error("account selection failed");
    return chosen;
  }

  /**
   * Classify a failure and drive the job to its terminal or retry state.
   * Returns "terminal" when the job reached FAILED/NEEDS_ATTENTION/CANCELLED,
   * or "retry" when it is in RETRY_WAIT (after backoff) — the run loop then
   * advances to WAITING_FOR_ACCOUNT and executes again.
   */
  private async handleFailure(
    jobId: string,
    accountId: string,
    attemptNo: number,
    nodeId: string | null,
    attemptStart: string,
    archive: JobArchive,
    err: unknown,
    wasAborted: boolean,
  ): Promise<"terminal" | "retry"> {
    const job = this.d.jobs.getOrThrow(jobId);
    let failureClass: FailureClass;
    let message: string;
    let ambiguous = false;
    let needsReauth = false;

    if (err instanceof ProviderFailure) {
      failureClass = err.info.failureClass;
      message = err.info.message;
      ambiguous = err.info.ambiguous;
      needsReauth = err.info.needsReauth;
    } else {
      failureClass = classifyError(String(err));
      message = String(err);
    }
    message = redact(message);

    try {
      if (needsReauth || failureClass === "auth") {
        this.d.accounts.recordError(accountId, message, "AUTH_REQUIRED");
      } else if (failureClass === "rate_limit") {
        this.d.accounts.recordError(accountId, message, "RATE_LIMITED");
      } else if (
        failureClass === "connectivity" ||
        failureClass === "provider" ||
        failureClass === "proxy"
      ) {
        this.d.accounts.recordError(accountId, message, "DEGRADED");
      }
    } catch {
      /* account may have been removed */
    }

    const cancelled = wasAborted || job.status === "CANCEL_REQUESTED";
    if (cancelled) {
      void this.d.provider.cancel(jobId).catch(() => {});
      this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "cancelled", {
        reason: "user",
      });
      // Cancellation must pass through CANCEL_REQUESTED (state machine rule).
      if (this.d.jobs.getOrThrow(jobId).status === "RUNNING") {
        this.d.jobs.setStatus(jobId, "CANCEL_REQUESTED");
      }
      this.d.jobs.setStatus(jobId, "CANCELLED", {
        errorClass: "provider",
        errorMessage: "cancelled by user",
      });
      this.logEvent(jobId, archive, "cancelled", "cancellation completed");
      return "terminal";
    }

    if (ambiguous) {
      this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "ambiguous", {
        failureClass,
        message,
      });
      this.d.jobs.setStatus(jobId, "NEEDS_ATTENTION", {
        errorClass: "ambiguous",
        errorMessage: message,
      });
      this.logEvent(jobId, archive, "needs_attention", `ambiguous: ${message}`);
      return "terminal";
    }

    if (!isRetryableError(failureClass) || attemptNo >= job.maxAttempts) {
      this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "failed", {
        failureClass,
        message,
      });
      this.d.jobs.setStatus(jobId, "FAILED", { errorClass: failureClass, errorMessage: message });
      this.logEvent(jobId, archive, "failed", `${failureClass}: ${message}`);
      return "terminal";
    }

    const delay = backoffMs(job.attempt + 1, { rng: this.d.rng });
    this.d.jobs.recordAttempt(jobId, attemptNo, accountId, nodeId, attemptStart, "retrying", {
      failureClass,
      message,
      nextDelayMs: delay,
    });
    this.d.jobs.setStatus(jobId, "RETRY_WAIT", { errorClass: failureClass, errorMessage: message });
    this.logEvent(
      jobId,
      archive,
      "retry_scheduled",
      `${failureClass}: retrying in ${delay}ms (attempt ${job.attempt + 1}/${job.maxAttempts})`,
    );
    await (this.d.sleep ?? sleepDefault)(delay);
    // Caller advances RETRY_WAIT -> WAITING_FOR_ACCOUNT and re-executes.
    return "retry";
  }

  /**
   * The upload route stores audio at data/jobs/<id>/input/audio-<safeName>.
   * We re-derive the same deterministic safe name here.
   */
  private audioPathInArchive(jobId: string, originalName: string, size: number): string | null {
    if (size <= 0 || !originalName) return null;
    let safe: string;
    try {
      safe = safeName(originalName);
    } catch {
      return null;
    }
    return resolveWithin(this.d.jobsDir, jobId, "input", `audio-${safe}`);
  }

  private storeArtifacts(
    jobId: string,
    stored: { safeName: string; size: number }[],
    metas: { name: string; mediaType: string }[],
  ): void {
    const db = this.d.jobs as unknown as { db: { raw: DatabaseSync; now(): string } };
    for (let i = 0; i < stored.length; i++) {
      const s = stored[i];
      const m = metas[i];
      if (!s) continue;
      const id = `art_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
      db.db.raw
        .prepare(
          "INSERT INTO artifacts (id, job_id, filename, media_type, size, source, storage_key, created_at) VALUES (?,?,?,?,?,?,?,?)",
        )
        .run(
          id,
          jobId,
          m?.name ?? s.safeName,
          m?.mediaType ?? "application/octet-stream",
          s.size,
          "provider",
          `output/artifacts/${s.safeName}`,
          db.db.now(),
        );
    }
  }

  /** Append to both the DB event log and the archive timeline (best-effort). */
  private logEvent(
    jobId: string,
    archive: JobArchive,
    type: string,
    message: string,
    data: Record<string, unknown> = {},
  ): void {
    this.d.jobs.appendEvent(jobId, type, message, data);
    try {
      archive.appendTimelineEvent({ at: new Date().toISOString(), type, message, data });
    } catch {
      /* archive is best-effort */
    }
  }

  /** Persist attempts + errors snapshots to the archive (best-effort). */
  private finalizeArchive(jobId: string, archive: JobArchive): void {
    try {
      const attempts = this.d.jobs.attempts(jobId);
      archive.writeAttempts(attempts);
      archive.writeErrors(attempts.filter((a) => a.outcome !== "ok"));
    } catch {
      /* archive is best-effort */
    }
  }
}

/** Minimal redaction for internal logs. */
function redact(s: string): string {
  return s
    .replace(/vless:\/\/[^\s"'<>]+/gi, "vless://[REDACTED]")
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi,
      (m) => `${m.slice(0, 4)}…`,
    );
}
