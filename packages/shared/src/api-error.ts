/**
 * Consistent API error envelope:
 *   { "error": { "code": string, "message": string, "details"?: unknown } }
 *
 * `code` is stable/machine-readable; `message` is human-readable and MUST be
 * already redacted. No stack traces, no credentials.
 */

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly httpStatus: number = 400,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

export function toApiErrorBody(err: unknown): {
  error: { code: string; message: string; details?: unknown };
} {
  if (err instanceof ApiError) {
    return {
      error: {
        code: err.code,
        message: err.message,
        ...(err.details ? { details: err.details } : {}),
      },
    };
  }
  if (err instanceof Error) {
    // Never leak raw message for unexpected errors (may contain paths/secrets).
    return { error: { code: "internal_error", message: "An unexpected error occurred." } };
  }
  return { error: { code: "internal_error", message: "An unexpected error occurred." } };
}

/** Standard 204/200 helpers keep route handlers uniform. */
export const ApiCodes = {
  notFound: "not_found",
  validation: "validation_error",
  conflict: "conflict",
  unauthorized: "unauthorized",
  forbidden: "forbidden",
  rateLimited: "rate_limited",
  invalidState: "invalid_state_transition",
  ssrfBlocked: "ssrf_blocked",
  secretNotFound: "secret_not_found",
  providerUnavailable: "provider_unavailable",
  runtimeNotConfigured: "runtime_not_configured",
} as const;
