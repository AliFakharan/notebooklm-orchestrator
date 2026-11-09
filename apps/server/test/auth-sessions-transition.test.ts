import { afterEach, describe, expect, it } from "vitest";
import { makeParts, addAccount, type TestParts } from "./helpers.js";
import { AuthSessionsRepo, InvalidAuthTransitionError } from "../src/domain/auth-sessions.repo.js";

/**
 * State-machine regression: re-verifying an existing stored file is a
 * legitimate recovery, so SESSION_EXPIRED may move directly to AUTHENTICATED.
 * SESSION_INVALID stays sticky (a re-import via AUTH_IN_PROGRESS is required).
 */

let parts: TestParts;
let sessions: AuthSessionsRepo;

afterEach(() => parts.dispose());

function setup() {
  parts = makeParts();
  sessions = new AuthSessionsRepo(parts.db);
}

/** Drive a freshly-ensured session (AUTH_REQUIRED) to the given pre-state. */
function driveTo(accountId: string, state: string): void {
  const P = "python-worker";
  sessions.ensure(accountId, P, "default"); // -> AUTH_REQUIRED
  const paths: Record<string, string[]> = {
    AUTH_REQUIRED: [],
    AUTHENTICATED: ["AUTHENTICATED"],
    AUTH_IN_PROGRESS: ["AUTH_IN_PROGRESS"],
    DISABLED: ["DISABLED"],
    SESSION_EXPIRED: ["AUTHENTICATED", "SESSION_EXPIRED"],
    SESSION_INVALID: ["AUTH_IN_PROGRESS", "SESSION_INVALID"],
    ACCESS_UNAVAILABLE: ["AUTHENTICATED", "ACCESS_UNAVAILABLE"],
    CONFIGURED: ["DISABLED", "CONFIGURED"],
  };
  for (const hop of paths[state] ?? []) {
    sessions.transition(accountId, P, hop as never, {});
  }
}

describe("auth session state machine", () => {
  it("allows SESSION_EXPIRED -> AUTHENTICATED (re-verify recovers an existing file)", () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    driveTo(id, "SESSION_EXPIRED");

    const after = sessions.transition(id, "python-worker", "AUTHENTICATED", {
      email: "me@gmail.com",
      verified: true,
    });
    expect(after.state).toBe("AUTHENTICATED");
    expect(after.lastVerifiedAt).toBeTruthy();
  });

  it("still allows SESSION_EXPIRED -> AUTH_REQUIRED (service rejects)", () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    driveTo(id, "SESSION_EXPIRED");

    const after = sessions.transition(id, "python-worker", "AUTH_REQUIRED", {
      lastError: "rejected",
    });
    expect(after.state).toBe("AUTH_REQUIRED");
  });

  it("keeps SESSION_INVALID sticky: cannot jump straight to AUTHENTICATED", () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    driveTo(id, "SESSION_INVALID");

    expect(() =>
      sessions.transition(id, "python-worker", "AUTHENTICATED", {
        email: "me@gmail.com",
        verified: true,
      }),
    ).toThrow(InvalidAuthTransitionError);
  });

  it("keeps SESSION_INVALID recoverable via the import path (AUTH_IN_PROGRESS)", () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    driveTo(id, "SESSION_INVALID");

    sessions.transition(id, "python-worker", "AUTH_IN_PROGRESS", {});
    const after = sessions.transition(id, "python-worker", "AUTHENTICATED", {
      email: "me@gmail.com",
      verified: true,
    });
    expect(after.state).toBe("AUTHENTICATED");
  });

  it("rejects still-illegal jumps (e.g. CONFIGURED -> AUTHENTICATED)", () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    driveTo(id, "CONFIGURED");

    expect(() =>
      sessions.transition(id, "python-worker", "AUTHENTICATED", {
        email: "me@gmail.com",
        verified: true,
      }),
    ).toThrow(InvalidAuthTransitionError);
  });

  it("allows an AUTHENTICATED self-update (keeper re-poke)", () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    driveTo(id, "AUTHENTICATED");

    // Same-state update is a no-op on validity; it must not throw.
    const after = sessions.transition(id, "python-worker", "AUTHENTICATED", {
      email: "me@gmail.com",
      verified: true,
    });
    expect(after.state).toBe("AUTHENTICATED");
  });
});
