import { ApiError, redactSecrets, type AuthSession } from "@nlo/shared";
import type { ProviderAccountStatus } from "../providers/types.js";
import type { AccountRow, AccountsRepo } from "../domain/accounts.repo.js";
import type { AuthSessionsRepo } from "../domain/auth-sessions.repo.js";
import type { SessionChecksRepo } from "../domain/session-checks.repo.js";
import type { AuthGuard } from "../auth/auth-guard.js";
import { VERIFY_PROVIDER, verifyCore, type VerifyResult } from "../auth/verify-service.js";
import { baleMessages } from "../notify/bale.js";

/** Anything that can deliver a plain-text alert (BaleNotifier satisfies this). */
export interface Notifier {
  send(text: string): Promise<void>;
}

/**
 * SessionKeeper: background loop that keeps stored Google sessions fresh.
 *
 * Why it exists: `AuthSessionsRepo.isUsable()` only trusts a session verified
 * within a 10-minute TTL, and nothing else refreshed `lastVerifiedAt` in the
 * background. The keeper periodically re-verifies (via the real, tunnel-routed
 * verify path) which both CONFIRMS the session and ROTATES its cookies
 * (notebooklm-py persists rotated cookies back to the storage file), so the
 * "usable" window stays satisfied for as long as the server runs.
 *
 * Safety invariants:
 *  - pokes ONLY `AUTHENTICATED` sessions; AUTH_REQUIRED / DISABLED /
 *    AUTH_IN_PROGRESS are left alone (no hammering Google, no racing a
 *    user-driven re-login)
 *  - shares `authGuard` with the UI routes so a poke never overlaps a
 *    concurrent import/verify on the same 0600 file
 *  - an infra failure (tunnel/worker/timeout) NEVER flips a session to
 *    AUTH_REQUIRED — it is recorded and, after 3 consecutive, surfaced once
 *  - sequential per cycle, never overlapping, re-armed after each cycle
 */

export interface SessionKeeperDeps {
  /** Poke interval in ms. Must be > 0 (the caller guards this). */
  intervalMs: number;
  /** Delay before the first cycle so a fresh boot doesn't starve job selection. */
  initialDelayMs?: number;
  accounts: AccountsRepo;
  sessions: AuthSessionsRepo;
  provider: {
    getAccountStatus(accountId: string, credentialRef: string): Promise<ProviderAccountStatus>;
  };
  authGuard: AuthGuard;
  checks: SessionChecksRepo;
  notifier: Notifier;
  log?: (msg: string) => void;
}

const DEFAULT_INITIAL_DELAY_MS = 2_000;
/** Consecutive infra failures before one deduped "cannot verify" alert. */
const INFRA_ALERT_THRESHOLD = 3;

export class SessionKeeper {
  private timer: NodeJS.Timeout | null = null;
  private cycleRunning = false;
  private stopped = false;
  /** The in-flight (or last-run) cycle, so stop() can drain it. */
  private cyclePromise: Promise<void> | null = null;
  /** Accounts we've already told the user expired (for a recovery message). */
  private readonly notifiedExpired = new Set<string>();
  /** Per-account consecutive infra-failure streak. */
  private readonly infraStreak = new Map<string, number>();
  /** Accounts already sent a "cannot verify (infra)" alert (deduped). */
  private readonly infraAlerted = new Set<string>();

  constructor(private readonly deps: SessionKeeperDeps) {}

  private get log() {
    return this.deps.log ?? (() => {});
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    const delay = this.deps.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
    this.log(
      `session keeper: started (interval ${this.deps.intervalMs}ms, first cycle in ${delay}ms)`,
    );
    this.timer = setTimeout(() => {
      this.cyclePromise = this.runCycle();
    }, delay);
  }

  /**
   * Stop scheduling new cycles and drain any in-flight one, so callers can
   * close shared resources (e.g. the DB) without racing a mid-verify write.
   * Resolves once the current cycle (at most one verify) has finished.
   */
  stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.log("session keeper: stopped");
    return this.cyclePromise ?? Promise.resolve();
  }

  /** True while a cycle is executing (exposed for tests/observability). */
  get active(): boolean {
    return this.cycleRunning;
  }

  private armNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      this.cyclePromise = this.runCycle();
    }, this.deps.intervalMs);
  }

  async runCycle(): Promise<void> {
    if (this.cycleRunning) return; // never overlap
    this.cycleRunning = true;
    try {
      const accounts = this.deps.accounts.list();
      for (const acct of accounts) {
        if (this.stopped) break;
        await this.checkAccount(acct).catch((e) => {
          // A per-account failure must not kill the whole cycle.
          this.log(
            `keeper[${acct.label}]: unexpected cycle error: ${
              e instanceof Error ? redactSecrets(e.message) : String(e)
            }`,
          );
        });
      }
    } finally {
      this.cycleRunning = false;
      this.armNext();
    }
  }

  private async checkAccount(acct: AccountRow): Promise<void> {
    const id = acct.id;
    if (!acct.enabled) return;
    const before = this.deps.sessions.get(id, VERIFY_PROVIDER);
    if (!before) return;
    // Only poke verified sessions; everything else is left to the user.
    if (before.state !== "AUTHENTICATED") return;
    if (this.deps.authGuard.running(id)) return;

    // Grab the shared guard; a concurrent UI op (import/verify) may have taken
    // it between the running() check and enter() — treat as a benign skip.
    let entered = false;
    try {
      this.deps.authGuard.enter(id);
      entered = true;
    } catch (e) {
      if (e instanceof ApiError && e.httpStatus === 409) return;
      this.log(`keeper[${acct.label}]: guard conflict (unexpected): ${String(e)}`);
      return;
    }

    try {
      const result = await verifyCore(
        {
          accounts: this.deps.accounts,
          sessions: this.deps.sessions,
          provider: this.deps.provider,
        },
        id,
      );
      if (result.ok) {
        await this.handleOk(acct, result);
      } else {
        await this.handleAuthFail(acct, before, result);
      }
    } catch (e) {
      // Any throw here (infra: tunnel/worker/timeout/rate_limit, or an
      // unexpected fault) means "cannot verify" — NO state change, and never
      // a false "expired" alert.
      await this.handleInfraError(acct, before, e);
    } finally {
      if (entered) this.deps.authGuard.leave(id);
    }
  }

  private async handleOk(acct: AccountRow, r: VerifyResult): Promise<void> {
    this.deps.checks.record(acct.id, "ok", redactSecrets(r.detail ?? "verified"));
    // Healthy check: reset the infra streak and clear any infra-alert dedupe.
    this.infraStreak.set(acct.id, 0);
    this.infraAlerted.delete(acct.id);
    // If we previously told the user this account expired, report recovery.
    if (this.notifiedExpired.has(acct.id)) {
      this.notifiedExpired.delete(acct.id);
      await this.safeSend(baleMessages.recovery(r.email ?? acct.displayEmail));
      this.log(`keeper[${acct.label}]: sent recovery notification`);
    }
  }

  private async handleAuthFail(
    acct: AccountRow,
    before: AuthSession,
    r: VerifyResult,
  ): Promise<void> {
    // verifyCore already transitioned AUTHENTICATED -> AUTH_REQUIRED.
    this.deps.checks.record(acct.id, "auth_failed", redactSecrets(r.detail ?? "session rejected"));
    const after = this.deps.sessions.get(acct.id, VERIFY_PROVIDER);
    if (before.state === "AUTHENTICATED" && after?.state === "AUTH_REQUIRED") {
      this.notifiedExpired.add(acct.id);
      await this.safeSend(baleMessages.expiry(before.email ?? acct.displayEmail));
      this.log(`keeper[${acct.label}]: session rejected by service; sent expiry notification`);
    }
  }

  private async handleInfraError(acct: AccountRow, before: AuthSession, e: unknown): Promise<void> {
    const msg = e instanceof Error ? e.message : String(e);
    this.deps.checks.record(acct.id, "infra_error", redactSecrets(msg));
    const streak = (this.infraStreak.get(acct.id) ?? 0) + 1;
    this.infraStreak.set(acct.id, streak);
    this.log(`keeper[${acct.label}]: infra error (streak ${streak}): ${redactSecrets(msg)}`);
    if (streak >= INFRA_ALERT_THRESHOLD && !this.infraAlerted.has(acct.id)) {
      this.infraAlerted.add(acct.id);
      await this.safeSend(baleMessages.infra(before.email ?? acct.displayEmail));
      this.log(`keeper[${acct.label}]: sent infra (cannot verify) notification`);
    }
  }

  private async safeSend(text: string): Promise<void> {
    try {
      await this.deps.notifier.send(text);
    } catch (e) {
      // The notifier is contractually non-throwing; defend anyway.
      this.log(`keeper: notifier failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
}
