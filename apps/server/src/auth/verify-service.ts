import type { AuthSession } from "@nlo/shared";
import type { AppContext } from "../app-context.js";
import type { AccountsRepo } from "../domain/accounts.repo.js";
import type { AuthSessionsRepo } from "../domain/auth-sessions.repo.js";
import type { ProviderAccountStatus } from "../providers/types.js";

/**
 * Shared session-verify service.
 *
 * Extracted from the sessions route so the API (POST /verify, /refresh,
 * /import) and the background SessionKeeper both perform the exact same
 * service-verified check + state transitions. There is one code path for
 * "ask the real service whether this stored session is still live".
 *
 * Semantics (unchanged from the old route logic):
 *  - the service verdict decides the state — never the file alone
 *  - ok  -> AUTHENTICATED (+ account identity sync)
 *  - !ok -> AUTH_REQUIRED (session.lastError carries the reason)
 *  - a hard provider error (worker down, tunnel failure, ...) THROWS before
 *    any transition — the caller (route / keeper) classifies it.
 *  - a verified identity mismatch never leaves the account "green".
 */

/** The provider whose storage-state files this verify path is written for. */
export const VERIFY_PROVIDER = "python-worker";

export interface VerifyResult {
  ok: boolean;
  email: string | null;
  detail: string | null;
  /** True when the service-verified identity differs from the account's. */
  mismatch: boolean;
  session: AuthSession;
}

/** Narrow dependencies — the full AppContext satisfies this structurally. */
export interface VerifyDeps {
  accounts: AccountsRepo;
  sessions: AuthSessionsRepo;
  provider: {
    getAccountStatus(accountId: string, credentialRef: string): Promise<ProviderAccountStatus>;
  };
}

/** Keep the account row in sync after a service-verified session. */
export function syncAccountIdentity(
  deps: VerifyDeps,
  accountId: string,
  email: string | null,
): void {
  const acct = deps.accounts.get(accountId);
  if (!acct || !email) return;
  if (acct.displayEmail !== email) {
    deps.accounts.update(accountId, { displayEmail: email });
  }
  // A verified login clears a stale AUTH_REQUIRED flag set by an earlier
  // failed job — the fresh service verification is stronger evidence.
  // DISABLED (manual) always wins and is never overridden here.
  if (acct.status === "AUTH_REQUIRED" || acct.status === "UNKNOWN") {
    deps.accounts.update(accountId, { status: "ACTIVE" });
  }
  deps.accounts.update(accountId, { lastVerifiedAt: new Date().toISOString() });
}

/**
 * Enforce "never associate a session with the wrong account": when the
 * account row carries an expected email and the service-verified identity
 * differs, the session is rejected as SESSION_INVALID with a clear error.
 * Returns the mismatch message, or null when there is no mismatch.
 */
export function mismatchFor(
  deps: VerifyDeps,
  accountId: string,
  verifiedEmail: string | null,
): string | null {
  const acct = deps.accounts.get(accountId);
  if (!acct || !acct.displayEmail || !verifiedEmail) return null;
  if (acct.displayEmail.trim().toLowerCase() === verifiedEmail.trim().toLowerCase()) return null;
  return `identity mismatch: session belongs to ${verifiedEmail}, but this account is for ${acct.displayEmail}`;
}

/**
 * Run the live, tunnel-routed service check of the stored session and apply
 * the resulting transitions. Returns the verdict; throws on hard provider
 * errors (no state change in that case).
 */
export async function verifyCore(deps: VerifyDeps, accountId: string): Promise<VerifyResult> {
  const acct = deps.accounts.getOrThrow(accountId);
  deps.sessions.ensure(accountId, VERIFY_PROVIDER, acct.authProfile ?? "default");
  const status = await deps.provider.getAccountStatus(accountId, "session");
  // AUTH_REQUIRED is reachable from every state (it is also a valid
  // self-update), so a single target suffices for the failure path.
  if (status.ok) {
    const session = deps.sessions.transition(accountId, VERIFY_PROVIDER, "AUTHENTICATED", {
      email: status.email,
      verified: true,
    });
    // Detect a mismatch against the account's CURRENT (expected) email BEFORE
    // syncing identity — syncing would rewrite displayEmail to the verified
    // email and hide the mismatch. On a mismatch we never reassign the
    // account's identity to a stranger's session ("never green").
    const mismatch = mismatchFor(deps, accountId, status.email);
    if (!mismatch) {
      syncAccountIdentity(deps, accountId, status.email);
    }
    return {
      ok: true,
      email: status.email,
      detail: mismatch ? `verified, but: ${mismatch}` : status.detail,
      mismatch: mismatch !== null,
      session,
    };
  }
  const session = deps.sessions.transition(accountId, VERIFY_PROVIDER, "AUTH_REQUIRED", {
    lastError: status.detail ?? "session rejected by service",
  });
  return {
    ok: false,
    email: null as string | null,
    detail: status.detail,
    mismatch: false,
    session,
  };
}

/** Convenience wrapper for callers that hold the full AppContext. */
export function verifySession(ctx: AppContext, accountId: string): Promise<VerifyResult> {
  return verifyCore(
    { accounts: ctx.accounts, sessions: ctx.sessions, provider: ctx.provider },
    accountId,
  );
}
