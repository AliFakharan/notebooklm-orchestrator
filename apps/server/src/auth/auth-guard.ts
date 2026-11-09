import { ApiError, ApiCodes } from "@nlo/shared";

/**
 * AuthGuard: one auth operation at a time per account.
 *
 * Concurrent login/import/verify would race on the same 0600 session file
 * (both read and, on verify, write rotated cookies back). The guard is the
 * shared, process-wide in-flight set — lifted out of the sessions route so
 * the background session keeper and the UI routes serialize on the same lock.
 *
 * `enter` throws an ApiError(409) on conflict so callers surface a clean
 * "already running" to the client.
 */
export interface AuthGuard {
  /** Throws ApiError(409) when the account already has an auth op in flight. */
  enter(accountId: string): void;
  /** Release the lock (idempotent). */
  leave(accountId: string): void;
  /** True when an auth op for the account is currently in flight. */
  running(accountId: string): boolean;
}

export class AuthGuardImpl implements AuthGuard {
  private readonly inFlight = new Set<string>();

  enter(accountId: string): void {
    if (this.inFlight.has(accountId)) {
      throw new ApiError(
        ApiCodes.conflict,
        "an authentication operation is already running",
        409,
      );
    }
    this.inFlight.add(accountId);
  }

  leave(accountId: string): void {
    this.inFlight.delete(accountId);
  }

  running(accountId: string): boolean {
    return this.inFlight.has(accountId);
  }
}
