import type { FailureClass } from "./types.js";

/**
 * Error classification + bounded retry policy.
 *
 * NOT every error is retryable. `ambiguous` (unknown completion) is NEVER
 * auto-retried — it goes to NEEDS_ATTENTION for human reconciliation.
 */

const RETRYABLE: Record<FailureClass, boolean> = {
  auth: false, // needs re-auth, not a blind retry
  rate_limit: true, // back off, then retry
  invalid_input: false, // will fail identically
  connectivity: true, // transient network
  proxy: true, // tunnel/runtime issues are transient (but fail-closed first)
  provider: true, // transient provider errors only
  ambiguous: false, // NEVER auto-retry
  unknown: false, // default-deny
};

export function isRetryableError(cls: FailureClass): boolean {
  return RETRYABLE[cls];
}

/**
 * Classify a raw error into a FailureClass. Heuristic, but conservative:
 * anything unrecognized is `unknown` (not retried).
 */
export function classifyError(message: string, httpStatus?: number): FailureClass {
  const m = message.toLowerCase();
  if (
    httpStatus === 401 ||
    httpStatus === 403 ||
    /auth|login|unauthor|credential|sid expired|session expired/.test(m)
  ) {
    return "auth";
  }
  if (
    httpStatus === 429 ||
    (/rate.?limit|quota|too many requests|503/.test(m) && httpStatus !== undefined)
  ) {
    return "rate_limit";
  }
  if (
    httpStatus === 400 ||
    (/invalid|bad request|unsupported|malformed/.test(m) &&
      httpStatus !== undefined &&
      httpStatus < 500)
  ) {
    return "invalid_input";
  }
  if (/dns|econnrefused|econnreset|etimedout|enotfound|fetch failed|network/.test(m)) {
    return "connectivity";
  }
  if (/proxy|tunnel|egress|vless|xray|listener/.test(m)) {
    return "proxy";
  }
  if (/unknown completion|ambiguous|interrupted mid-operation|worker died/.test(m)) {
    return "ambiguous";
  }
  if (httpStatus !== undefined && httpStatus >= 500) {
    return "provider";
  }
  return "unknown";
}

/** Exponential backoff with full jitter. Deterministic when `rng` supplied. */
export function backoffMs(
  attempt: number,
  opts: { baseMs?: number; capMs?: number; jitter?: number; rng?: () => number } = {},
): number {
  const base = opts.baseMs ?? 2000;
  const cap = opts.capMs ?? 300_000;
  const jitter = opts.jitter ?? 1; // 1 = full jitter
  const rng = opts.rng ?? Math.random;

  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  const lo = jitter === 1 ? 0 : exp * (1 - jitter);
  return Math.floor(lo + rng() * (exp - lo));
}
