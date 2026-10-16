import { describe, expect, it } from "vitest";
import {
  canTransition,
  InvalidStateTransitionError,
  isRestartRecoverable,
  isTerminal,
  RESTART_RESET_STATUS,
  transition,
} from "../src/job-state.js";
import type { JobStatus } from "../src/types.js";

describe("job state machine", () => {
  it("allows the happy path", () => {
    const path: JobStatus[] = [
      "CREATED",
      "VALIDATING",
      "QUEUED",
      "WAITING_FOR_ACCOUNT",
      "WAITING_FOR_PROXY",
      "RUNNING",
      "SUCCEEDED",
    ];
    for (let i = 0; i < path.length - 1; i++) {
      const from = path[i] as JobStatus;
      const to = path[i + 1] as JobStatus;
      expect(transition(from, to)).toBe(to);
    }
  });

  it("rejects skipping straight to success", () => {
    expect(() => transition("CREATED", "SUCCEEDED")).toThrow(InvalidStateTransitionError);
    expect(canTransition("CREATED", "SUCCEEDED")).toBe(false);
  });

  it("rejects transitions out of terminal states", () => {
    for (const t of ["SUCCEEDED", "FAILED", "CANCELLED"] as JobStatus[]) {
      expect(isTerminal(t)).toBe(true);
      expect(() => transition(t, "QUEUED")).toThrow(InvalidStateTransitionError);
    }
  });

  it("routes ambiguous completion to NEEDS_ATTENTION and not to a blind retry", () => {
    expect(canTransition("RUNNING", "NEEDS_ATTENTION")).toBe(true);
    expect(canTransition("NEEDS_ATTENTION", "QUEUED")).toBe(true); // human re-queues
    expect(canTransition("NEEDS_ATTENTION", "CANCELLED")).toBe(true);
    expect(canTransition("NEEDS_ATTENTION", "RUNNING")).toBe(false);
  });

  it("supports cancel from in-flight states and only via CANCEL_REQUESTED", () => {
    expect(canTransition("RUNNING", "CANCEL_REQUESTED")).toBe(true);
    expect(canTransition("CANCEL_REQUESTED", "CANCELLED")).toBe(true);
    expect(canTransition("RUNNING", "CANCELLED")).toBe(false); // must request first
    expect(canTransition("SUCCEEDED", "CANCEL_REQUESTED")).toBe(false);
  });

  it("retries only back through WAITING_FOR_ACCOUNT", () => {
    expect(canTransition("RUNNING", "RETRY_WAIT")).toBe(true);
    expect(canTransition("RETRY_WAIT", "WAITING_FOR_ACCOUNT")).toBe(true);
    expect(canTransition("RETRY_WAIT", "RUNNING")).toBe(false);
  });

  it("marks in-flight states as restart-recoverable and terminal as not", () => {
    expect(isRestartRecoverable("RUNNING")).toBe(true);
    expect(isRestartRecoverable("QUEUED")).toBe(true);
    expect(isRestartRecoverable("SUCCEEDED")).toBe(false);
    expect(isRestartRecoverable("CANCELLED")).toBe(false);
    expect(RESTART_RESET_STATUS).toBe("QUEUED");
  });
});
