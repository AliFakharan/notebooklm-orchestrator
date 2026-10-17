import { z } from "zod";

/**
 * JSON-line wire protocol between the Node supervisor and the Python worker
 * (nbl_worker.py). Every message is validated with zod on both ends.
 */

export const OpCodes = ["ping", "validate", "verify", "login", "browser-import", "job"] as const;
export type WorkerOp = (typeof OpCodes)[number];

export const WorkerRequest = z.object({
  id: z.number().int().positive(),
  op: z.enum(OpCodes),
  params: z.record(z.unknown()).default({}),
});
export type WorkerRequestT = z.infer<typeof WorkerRequest>;

const ErrorPayload = z.object({
  code: z.enum([
    "auth",
    "rate_limit",
    "timeout",
    "connectivity",
    "invalid_input",
    "not_found",
    "ambiguous",
    "configuration",
    "provider",
    "provider_unavailable",
    "protocol",
    "unknown",
  ]),
  message: z.string(),
});

export const WorkerResponse = z.object({
  id: z.number().int().positive(),
  ok: z.boolean(),
  result: z.record(z.unknown()).optional(),
  error: ErrorPayload.optional(),
});
export type WorkerResponseT = z.infer<typeof WorkerResponse>;

export const WorkerEvent = z.object({
  event: z.enum(["progress", "log"]),
  op: z.number().int().nullable(),
  data: z.record(z.unknown()).default({}),
});
export type WorkerEventT = z.infer<typeof WorkerEvent>;

/** A parsed inbound line: either a response or an event. */
export const WorkerInbound = WorkerResponse.or(WorkerEvent);
export type WorkerInboundT = z.infer<typeof WorkerInbound>;

export function isResponse(msg: WorkerInboundT): msg is WorkerResponseT {
  return "ok" in msg;
}

/** Worker-reported error code -> app failure class. */
export function failureClassFor(
  code: string,
):
  | "auth"
  | "rate_limit"
  | "timeout"
  | "connectivity"
  | "invalid_input"
  | "provider"
  | "ambiguous"
  | "unknown" {
  switch (code) {
    case "auth":
      return "auth";
    case "rate_limit":
      return "rate_limit";
    case "timeout":
      return "provider";
    case "connectivity":
      return "connectivity";
    case "invalid_input":
      return "invalid_input";
    case "ambiguous":
      return "ambiguous";
    case "provider_unavailable":
    case "configuration":
    case "provider":
      return "provider";
    case "protocol":
    case "not_found":
    default:
      return "unknown";
  }
}

/**
 * Whether a worker-side error code means "the external outcome is unknown"
 * (a non-idempotent operation may have completed on the service side).
 * These must NEVER be auto-retried by the runner.
 */
export function isAmbiguousCode(code: string): boolean {
  return code === "ambiguous" || code === "timeout";
}
