import { afterEach, describe, expect, it } from "vitest";
import { ProviderFailure, type ProviderAccountStatus } from "../src/providers/types.js";
import { makeParts, type TestParts } from "./helpers.js";
import { AuthSessionsRepo } from "../src/domain/auth-sessions.repo.js";
import { SessionChecksRepo } from "../src/domain/session-checks.repo.js";
import { AuthGuardImpl } from "../src/auth/auth-guard.js";
import { SessionKeeper } from "../src/session-keeper/keeper.js";
import { baleMessages } from "../src/notify/bale.js";

/**
 * SessionKeeper behavior (fake provider, no real timers):
 *  - ok              -> lastVerifiedAt fresh, "ok" check recorded
 *  - auth reject     -> AUTH_REQUIRED + exactly one expiry notification
 *  - infra throw     -> NO state change; one infra alert only after 3 streak
 *  - recovery        -> recovery message on the next ok after re-auth
 *  - skips           -> DISABLED / AUTH_IN_PROGRESS / in-flight (authGuard)
 */

const P = "python-worker";

class FakeProvider {
  handler: (id: string) => ProviderAccountStatus | Error | Promise<ProviderAccountStatus> = () => ({
    ok: true,
    email: "keepme@gmail.com",
    detail: "verified (3 notebooks)",
  });
  async getAccountStatus(id: string): Promise<ProviderAccountStatus> {
    const r = this.handler(id);
    if (r instanceof Error) throw r;
    return r;
  }
}

class FakeNotifier {
  messages: string[] = [];
  async send(text: string): Promise<void> {
    this.messages.push(text);
  }
}

interface KParts {
  parts: TestParts;
  sessions: AuthSessionsRepo;
  checks: SessionChecksRepo;
  authGuard: AuthGuardImpl;
  provider: FakeProvider;
  notifier: FakeNotifier;
  keeper: SessionKeeper;
}

function setup(): KParts {
  const parts = makeParts();
  const sessions = new AuthSessionsRepo(parts.db);
  const checks = new SessionChecksRepo(parts.db);
  const authGuard = new AuthGuardImpl();
  const provider = new FakeProvider();
  const notifier = new FakeNotifier();
  const keeper = new SessionKeeper({
    intervalMs: 60_000, // large: the re-arm timer never fires during a test
    accounts: parts.accounts,
    sessions,
    provider,
    authGuard,
    checks,
    notifier,
    log: () => {},
  });
  return { parts, sessions, checks, authGuard, provider, notifier, keeper };
}

function authenticate(k: KParts, id: string, email: string): void {
  k.sessions.ensure(id, P, "default");
  k.sessions.transition(id, P, "AUTHENTICATED", { email, verified: true });
}

/** Create an account whose identity is EXACTLY `email` (no suffix). */
function mkAccount(k: KParts, email: string): string {
  return k.parts.accounts.create({ email }).id;
}

afterEach(() => {
  // Clear any pending re-arm timer so vitest doesn't hold handles. Tests drive
  // cycles via runCycle() directly, so stop() has nothing to drain.
  void activeKeeper?.stop();
  activeParts?.dispose();
  activeKeeper = undefined;
  activeParts = undefined;
});

let activeKeeper: SessionKeeper | undefined;
let activeParts: TestParts | undefined;

function track(k: KParts): KParts {
  activeKeeper = k.keeper;
  activeParts = k.parts;
  return k;
}

describe("SessionKeeper", () => {
  it("ok poke refreshes lastVerifiedAt and records an 'ok' check", async () => {
    const k = track(setup());
    const id = mkAccount(k, "keepme@gmail.com");
    authenticate(k, id, "keepme@gmail.com");
    // Age the verification so we can prove it was refreshed.
    k.parts.db.raw
      .prepare("UPDATE auth_sessions SET last_verified_at = ? WHERE account_id = ?")
      .run(new Date(Date.now() - 6 * 60 * 1000).toISOString(), id);

    await k.keeper.runCycle();

    const session = k.sessions.get(id, P)!;
    expect(session.state).toBe("AUTHENTICATED");
    // Freshly re-verified (much newer than the 6-minute-old stamp).
    expect(Date.now() - Date.parse(session.lastVerifiedAt!)).toBeLessThan(60 * 1000);
    expect(k.parts.accounts.get(id)!.lastVerifiedAt).toBeTruthy();
    expect(k.checks.listForAccount(id).map((c) => c.outcome)).toEqual(["ok"]);
    expect(k.notifier.messages).toEqual([]);
  });

  it("auth reject -> AUTH_REQUIRED and exactly one expiry notification", async () => {
    const k = track(setup());
    const id = mkAccount(k, "keepme@gmail.com");
    authenticate(k, id, "keepme@gmail.com");
    k.provider.handler = () => ({ ok: false, email: null, detail: "session rejected" });

    await k.keeper.runCycle();
    expect(k.sessions.get(id, P)!.state).toBe("AUTH_REQUIRED");
    expect(k.checks.listForAccount(id).map((c) => c.outcome)).toEqual(["auth_failed"]);
    expect(k.notifier.messages).toEqual([baleMessages.expiry("keepme@gmail.com")]);

    // Second cycle: session is now AUTH_REQUIRED -> keeper skips, no repeat.
    await k.keeper.runCycle();
    expect(k.sessions.get(id, P)!.state).toBe("AUTH_REQUIRED");
    expect(k.notifier.messages).toHaveLength(1);
  });

  it("infra throw -> no state change; one alert only after 3 consecutive", async () => {
    const k = track(setup());
    const id = mkAccount(k, "keepme@gmail.com");
    authenticate(k, id, "keepme@gmail.com");
    k.provider.handler = () => {
      throw new ProviderFailure({
        failureClass: "proxy",
        message: "no proxy route available for auth (fail-closed)",
        ambiguous: false,
        needsReauth: false,
      });
    };

    await k.keeper.runCycle();
    expect(k.sessions.get(id, P)!.state).toBe("AUTHENTICATED"); // unchanged
    expect(k.notifier.messages).toHaveLength(0);

    await k.keeper.runCycle();
    expect(k.sessions.get(id, P)!.state).toBe("AUTHENTICATED");
    expect(k.notifier.messages).toHaveLength(0);

    await k.keeper.runCycle(); // third consecutive infra failure
    expect(k.sessions.get(id, P)!.state).toBe("AUTHENTICATED");
    expect(k.notifier.messages).toEqual([baleMessages.infra("keepme@gmail.com")]);

    // Fourth: deduped — still exactly one infra alert.
    await k.keeper.runCycle();
    expect(k.notifier.messages).toHaveLength(1);
    expect(k.checks.listForAccount(id).map((c) => c.outcome)).toEqual([
      "infra_error",
      "infra_error",
      "infra_error",
      "infra_error",
    ]);
  });

  it("recovery: after re-auth + ok poke, sends a recovery message once", async () => {
    const k = track(setup());
    const id = mkAccount(k, "keepme@gmail.com");
    authenticate(k, id, "keepme@gmail.com");

    // 1) Service rejects -> expiry notification.
    k.provider.handler = () => ({ ok: false, email: null, detail: "rejected" });
    await k.keeper.runCycle();
    expect(k.sessions.get(id, P)!.state).toBe("AUTH_REQUIRED");
    expect(k.notifier.messages).toEqual([baleMessages.expiry("keepme@gmail.com")]);

    // 2) User re-authenticates (import path) -> back to AUTHENTICATED.
    k.sessions.transition(id, P, "AUTHENTICATED", { email: "keepme@gmail.com", verified: true });
    k.provider.handler = () => ({ ok: true, email: "keepme@gmail.com", detail: "verified" });

    // 3) Next ok poke -> recovery notification, and the flag is cleared.
    await k.keeper.runCycle();
    expect(k.notifier.messages).toEqual([
      baleMessages.expiry("keepme@gmail.com"),
      baleMessages.recovery("keepme@gmail.com"),
    ]);

    // 4) Subsequent ok pokes do not re-send recovery.
    await k.keeper.runCycle();
    expect(k.notifier.messages).toHaveLength(2);
  });

  it("skips DISABLED, AUTH_IN_PROGRESS, and in-flight (authGuard) sessions", async () => {
    const k = track(setup());

    const disabledId = mkAccount(k, "disabled@gmail.com");
    k.sessions.ensure(disabledId, P, "default");
    k.sessions.transition(disabledId, P, "DISABLED", {});

    const inProgressId = mkAccount(k, "inprogress@gmail.com");
    k.sessions.ensure(inProgressId, P, "default");
    k.sessions.transition(inProgressId, P, "AUTH_IN_PROGRESS", {});

    const inFlightId = mkAccount(k, "inflight@gmail.com");
    authenticate(k, inFlightId, "inflight@gmail.com");
    k.authGuard.enter(inFlightId); // simulate a concurrent UI op
    k.provider.handler = (accountId: string) => {
      if (accountId === inFlightId) {
        throw new Error("should not be called");
      }
      return { ok: true, email: "x@gmail.com", detail: "ok" };
    };

    await k.keeper.runCycle();

    expect(k.sessions.get(disabledId, P)!.state).toBe("DISABLED");
    expect(k.sessions.get(inProgressId, P)!.state).toBe("AUTH_IN_PROGRESS");
    expect(k.sessions.get(inFlightId, P)!.state).toBe("AUTHENTICATED");
    // None of the three were poked.
    expect(k.checks.listForAccount(disabledId)).toHaveLength(0);
    expect(k.checks.listForAccount(inProgressId)).toHaveLength(0);
    expect(k.checks.listForAccount(inFlightId)).toHaveLength(0);
    expect(k.notifier.messages).toEqual([]);
    k.authGuard.leave(inFlightId);
  });

  it("skips accounts with no session row and disabled accounts", async () => {
    const k = track(setup());
    const noRowId = mkAccount(k, "norow@gmail.com");
    const offId = mkAccount(k, "off@gmail.com");
    k.parts.accounts.update(offId, { enabled: false });
    authenticate(k, offId, "off@gmail.com");

    await k.keeper.runCycle();

    expect(k.sessions.get(noRowId, P)).toBeNull();
    expect(k.checks.listForAccount(noRowId)).toHaveLength(0);
    expect(k.checks.listForAccount(offId)).toHaveLength(0);
  });

  it("stop() drains an in-flight cycle before resolving (no close race)", async () => {
    const k = track(setup());
    const id = mkAccount(k, "keepme@gmail.com");
    authenticate(k, id, "keepme@gmail.com");

    let providerCalled = false;
    let providerDoneAt = 0;
    // A deliberately slow verify so it is still in-flight when stop() is called.
    k.provider.handler = () => {
      providerCalled = true;
      return new Promise<ProviderAccountStatus>((resolve) =>
        setTimeout(() => {
          providerDoneAt = Date.now();
          resolve({ ok: true, email: "keepme@gmail.com", detail: "verified" });
        }, 80),
      );
    };

    const keeper = new SessionKeeper({
      intervalMs: 60_000,
      initialDelayMs: 1, // fire the first cycle almost immediately
      accounts: k.parts.accounts,
      sessions: k.sessions,
      provider: k.provider,
      authGuard: k.authGuard,
      checks: k.checks,
      notifier: k.notifier,
      log: () => {},
    });

    keeper.start();
    // Wait until the verify is actually in flight (provider invoked, pending).
    for (let i = 0; i < 400 && !providerCalled; i++) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(providerCalled).toBe(true);

    const p = keeper.stop();
    await p;
    const stopDoneAt = Date.now();

    // The in-flight verify completed and was recorded before stop() resolved.
    expect(k.checks.listForAccount(id).map((c) => c.outcome)).toEqual(["ok"]);
    // stop() resolved no earlier than the provider finished — i.e. it drained.
    expect(stopDoneAt).toBeGreaterThanOrEqual(providerDoneAt);
  });
});
