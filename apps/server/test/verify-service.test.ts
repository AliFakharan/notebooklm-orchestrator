import { afterEach, describe, expect, it } from "vitest";
import type { ProviderAccountStatus } from "../src/providers/types.js";
import { ProviderFailure } from "../src/providers/types.js";
import { makeParts, type TestParts } from "./helpers.js";
import { AuthSessionsRepo } from "../src/domain/auth-sessions.repo.js";
import { verifyCore } from "../src/auth/verify-service.js";

/**
 * Regression for the extracted verify service: same behavior as the old
 * inline route logic.
 *  - ok + matching identity   -> AUTHENTICATED, mismatch:false, account synced
 *  - ok + mismatching identity-> flagged mismatch:true (caller must not go green)
 *  - service rejects          -> AUTH_REQUIRED, ok:false
 *  - hard provider error      -> throws, NO state change
 */

let parts: TestParts;
let sessions: AuthSessionsRepo;

afterEach(() => parts.dispose());

function setup() {
  parts = makeParts();
  sessions = new AuthSessionsRepo(parts.db);
}

function fakeProvider(
  result: ProviderAccountStatus | (() => never),
): { getAccountStatus(id: string, ref: string): Promise<ProviderAccountStatus> } {
  return {
    async getAccountStatus(): Promise<ProviderAccountStatus> {
      if (typeof result === "function") {
        (result as () => never)(); // throws
      }
      return result as ProviderAccountStatus;
    },
  };
}

describe("verifyCore (shared verify service)", () => {
  it("ok + matching identity -> AUTHENTICATED, mismatch false, account row synced", async () => {
    setup();
    const id = parts.accounts.create({ email: "me@gmail.com" }).id;
    // The account was flagged AUTH_REQUIRED by an earlier failed job.
    parts.accounts.update(id, { status: "AUTH_REQUIRED" });

    const r = await verifyCore(
      { accounts: parts.accounts, sessions, provider: fakeProvider({ ok: true, email: "me@gmail.com", detail: "verified (2 notebooks)" }) },
      id,
    );

    expect(r.ok).toBe(true);
    expect(r.mismatch).toBe(false);
    expect(r.email).toBe("me@gmail.com");
    expect(r.session.state).toBe("AUTHENTICATED");
    expect(r.session.lastVerifiedAt).toBeTruthy();
    // Account identity sync: status cleared to ACTIVE, lastVerifiedAt fresh.
    const acct = parts.accounts.get(id)!;
    expect(acct.status).toBe("ACTIVE");
    expect(acct.lastVerifiedAt).toBeTruthy();
  });

  it("ok + mismatching identity -> flagged mismatch (never blindly green)", async () => {
    setup();
    const id = parts.accounts.create({ email: "alice@gmail.com" }).id;
    // The stored session actually belongs to someone else.
    const r = await verifyCore(
      { accounts: parts.accounts, sessions, provider: fakeProvider({ ok: true, email: "bob@gmail.com", detail: "verified (1 notebook)" }) },
      id,
    );

    expect(r.ok).toBe(true);
    expect(r.mismatch).toBe(true);
    expect(r.detail).toContain("identity mismatch");
    expect(r.detail).toContain("bob@gmail.com");
    // The session row is still AUTHENTICATED from verifyCore's perspective;
    // the CALLER (import route) is responsible for demoting to SESSION_INVALID
    // on r.mismatch. The point is verifyCore honestly reports the mismatch.
    expect(r.session.state).toBe("AUTHENTICATED");
  });

  it("service rejects -> AUTH_REQUIRED, ok:false, lastError carried", async () => {
    setup();
    const id = parts.accounts.create({ email: "me@gmail.com" }).id;
    // Start AUTHENTICATED so the AUTHENTICATED -> AUTH_REQUIRED hop is real.
    sessions.ensure(id, "python-worker", "default");
    sessions.transition(id, "python-worker", "AUTHENTICATED", { email: "me@gmail.com", verified: true });

    const r = await verifyCore(
      { accounts: parts.accounts, sessions, provider: fakeProvider({ ok: false, email: null, detail: "session rejected by service (re-login required)" }) },
      id,
    );

    expect(r.ok).toBe(false);
    expect(r.email).toBeNull();
    expect(r.mismatch).toBe(false);
    expect(r.session.state).toBe("AUTH_REQUIRED");
    expect(r.session.lastError).toContain("rejected");
  });

  it("hard provider error -> throws, and leaves the state unchanged", async () => {
    setup();
    const id = parts.accounts.create({ email: "me@gmail.com" }).id;
    sessions.ensure(id, "python-worker", "default");
    sessions.transition(id, "python-worker", "AUTHENTICATED", { email: "me@gmail.com", verified: true });

    const boom = () => {
      throw new ProviderFailure({
        failureClass: "proxy",
        message: "no proxy route available for auth (fail-closed)",
        ambiguous: false,
        needsReauth: false,
      });
    };
    await expect(
      verifyCore({ accounts: parts.accounts, sessions, provider: fakeProvider(boom) }, id),
    ).rejects.toThrow(ProviderFailure);

    // No state change: still AUTHENTICATED.
    expect(sessions.get(id, "python-worker")!.state).toBe("AUTHENTICATED");
  });

  it("throws when the account does not exist", async () => {
    setup();
    await expect(
      verifyCore(
        { accounts: parts.accounts, sessions, provider: fakeProvider({ ok: true, email: "x@y.z", detail: null }) },
        "acc_doesnotexist",
      ),
    ).rejects.toThrow(/account not found/);
  });
});
