import { JOB_TERMINAL_STATUSES, type JobStatus } from "./types.js";

/**
 * Central job state machine. All transitions in the app MUST go through
 * `canTransition` / `transition`. Invalid transitions throw.
 */
const TRANSITIONS: Record<JobStatus, readonly JobStatus[]> = {
  CREATED: ["VALIDATING", "CANCELLED"],
  VALIDATING: ["QUEUED", "FAILED", "CANCELLED"],
  QUEUED: ["WAITING_FOR_ACCOUNT", "FAILED", "CANCELLED"],
  WAITING_FOR_ACCOUNT: ["WAITING_FOR_PROXY", "FAILED", "CANCELLED"],
  WAITING_FOR_PROXY: ["RUNNING", "FAILED", "CANCELLED"],
  RUNNING: ["RETRY_WAIT", "SUCCEEDED", "FAILED", "NEEDS_ATTENTION", "CANCEL_REQUESTED"],
  RETRY_WAIT: ["WAITING_FOR_ACCOUNT", "FAILED", "CANCELLED"],
  SUCCEEDED: [],
  FAILED: [],
  NEEDS_ATTENTION: ["QUEUED", "CANCELLED"],
  CANCEL_REQUESTED: ["CANCELLED"],
  CANCELLED: [],
};

export function isTerminal(status: JobStatus): boolean {
  return (JOB_TERMINAL_STATUSES as readonly string[]).includes(status);
}

export function canTransition(from: JobStatus, to: JobStatus): boolean {
  return TRANSITIONS[from].includes(to);
}

export class InvalidStateTransitionError extends Error {
  constructor(
    public readonly from: JobStatus,
    public readonly to: JobStatus,
  ) {
    super(`Invalid job state transition: ${from} -> ${to}`);
    this.name = "InvalidStateTransitionError";
  }
}

/** Returns the next status, throwing on an illegal transition. */
export function transition(from: JobStatus, to: JobStatus): JobStatus {
  if (from === to) return from;
  if (!canTransition(from, to)) {
    throw new InvalidStateTransitionError(from, to);
  }
  return to;
}

/**
 * On application restart, jobs left in in-flight states must be recoverable:
 * they are reset to QUEUED so the worker can pick them up (or fail them if
 * inputs are no longer available).
 */
const RESTART_RECOVERABLE: readonly JobStatus[] = [
  "VALIDATING",
  "QUEUED",
  "WAITING_FOR_ACCOUNT",
  "WAITING_FOR_PROXY",
  "RUNNING",
  "RETRY_WAIT",
  "CANCEL_REQUESTED",
];

export function isRestartRecoverable(status: JobStatus): boolean {
  return RESTART_RECOVERABLE.includes(status);
}

/** The status a recoverable job is reset to after an app restart. */
export const RESTART_RESET_STATUS: JobStatus = "QUEUED";
