import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { PythonWorkerProvider } from "../src/providers/python-worker/python-worker-provider.js";
import type { AuthSessionState } from "@nlo/shared";
import { addAccount, addNode, dataPathsFor, makeAppContext, markHealthy } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

/**
 * Async cookie import (plan: proxy failover + async import, Task 5).
 *
 * POST /api/sessions/:id/import now returns 202 immediately: the tunnel-routed
 * verify against the real service runs in the background, and the UI polls
 * GET /api/sessions/:id/import-status (the session row IS the status).
 *
 * The ctx provider is swapped (before buildApp — the sessions route captures
 * the provider instance at registration) for a PythonWorkerProvider backed by
 * the deterministic fake worker (test/fake-worker.mjs, spawned via node).
 * The session keeper is disabled (NLO_SESSION_KEEPALIVE_MS=0) so no cycle
 * races the import.
 */

const FAKE_WORKER = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url));
const auth: Record<string, string> = {};

/** A minimal valid cookie document (storage state) the import route accepts. */
const COOKIE_DOC = JSON.stringify({
  cookies: [
    {
      name: "SID",
      value: "s3cr3t",
      domain: ".google.com",
      path: "/",
      expires: 2145900000,
      httpOnly: true,
      secure: true,
      sameSite: "none",
    },
  ],
  origins: [],
});

let ctx: AppContext;
let app: FastifyInstance;
/** The default account matches the fake worker's verified email. */
let accountId: string;
/** Set when a test closes the ctx itself (drain test) — skips the double close. */
let closedByTest = false;

function stateFile(): string {
  return path.join(ctx.config.dataDir, "worker-state.json");
}

function setWorkerEnv(script: string[], delayMs = 0): void {
  process.env.FAKE_WORKER_SCRIPT = JSON.stringify(script);
  process.env.FAKE_WORKER_STATE_FILE = stateFile();
  if (delayMs > 0) process.env.FAKE_WORKER_DELAY_MS = String(delayMs);
}

function setupNode(): string {
  const node = addNode(ctx.proxies, ctx.vault, "n1");
  markHealthy(ctx.proxies, node.id);
  return node.id;
}

function importReq(id: string = accountId) {
  return app.inject({
    method: "POST",
    url: `/api/sessions/${id}/import`,
    headers: { ...auth, "content-type": "application/json" },
    payload: { cookies: COOKIE_DOC },
  });
}

async function importStatus(id: string = accountId) {
  return app.inject({ method: "GET", url: `/api/sessions/${id}/import-status` });
}

async function waitForState(
  want: string,
  id: string = accountId,
  timeoutMs = 15_000,
): Promise<{ state: string; email: string | null; lastError: string | null }> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const res = await importStatus(id);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    if (body.state === want) return body;
    if (Date.now() > deadline) {
      throw new Error(
        `timed out waiting for ${want}; last=${body.state} err=${body.lastError ?? "-"}`,
      );
    }
    await new Promise((r) => setTimeout(r, 50));
  }
}

beforeEach(async () => {
  // intEnv/boolEnv in config read process.env directly (overrides are only
  // honored by the string env() helper), so the keeper is disabled via
  // process.env. NLO_PYTHON_BIN points nowhere: the ctx's ORIGINAL provider
  // (replaced below) must not spawn a real python worker at construction.
  process.env.NLO_SESSION_KEEPALIVE_MS = "0";
  process.env.NLO_PYTHON_BIN = "/nonexistent/nlo-test-python";
  ctx = await makeAppContext({ NLO_PROVIDER: "python-worker" });
  // Swap the ctx provider for the fake-worker provider BEFORE buildApp: the
  // sessions route captures the provider instance at registration time.
  const sessionDir = dataPathsFor(ctx.config.dataDir).sessionsDir;
  const fake = new PythonWorkerProvider({
    sessionDir,
    dataDir: ctx.config.dataDir,
    pythonBin: process.execPath,
    workerPath: FAKE_WORKER,
    allowDirect: false,
    proxyManager: ctx.proxyManager,
    proxiesRepo: {
      countEnabled: () => ctx.proxies.list().filter((n) => n.enabled).length,
      listEnabled: () => ctx.proxies.list().filter((n) => n.enabled).map((n) => ({ id: n.id })),
      health: (nodeId) => ctx.proxies.health(nodeId),
    },
    log: () => {},
  });
  (ctx as unknown as { provider: unknown }).provider = fake;
  app = await buildApp(ctx);
  await app.ready();
  // addAccount() appends @example.com: "fake" -> fake@example.com, which
  // matches the fake worker's verified email (no identity mismatch).
  accountId = addAccount(ctx.accounts, "fake").id;
  ctx.accounts.update(accountId, { status: "ACTIVE" });
});

afterEach(async () => {
  delete process.env.FAKE_WORKER_SCRIPT;
  delete process.env.FAKE_WORKER_STATE_FILE;
  delete process.env.FAKE_WORKER_DELAY_MS;
  delete process.env.NLO_SESSION_KEEPALIVE_MS;
  delete process.env.NLO_PYTHON_BIN;
  await app.close();
  if (!closedByTest) {
    await ctx.close();
  }
  closedByTest = false;
});

describe("POST /api/sessions/:id/import (202 + background verify)", () => {
  it("returns 202 immediately while the verify runs (AUTH_IN_PROGRESS)", async () => {
    setWorkerEnv(["ok"], 800);
    setupNode();
    const res = await importReq();
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ status: "accepted" });
    // Right after the 202 the background verify is in flight.
    const s = await importStatus();
    expect(s.statusCode).toBe(200);
    expect(s.json().state).toBe("AUTH_IN_PROGRESS");
    const final = await waitForState("AUTHENTICATED");
    expect(final.email).toBe("fake@example.com");
  });

  it("polling import-status reaches AUTHENTICATED with the verified email", async () => {
    setWorkerEnv(["ok"], 300);
    setupNode();
    const res = await importReq();
    expect(res.statusCode).toBe(202);
    const final = await waitForState("AUTHENTICATED");
    expect(final.email).toBe("fake@example.com");
    expect(final.lastError).toBeNull();
    // The account view reflects the verified session.
    const view = await app.inject({ method: "GET", url: `/api/sessions/${accountId}` });
    expect(view.statusCode).toBe(200);
    const body = view.json();
    expect(body.session.state).toBe("AUTHENTICATED");
    expect(body.session.email).toBe("fake@example.com");
    expect(body.sessionUsable).toBe(true);
  });

  it("service rejection (auth) -> AUTH_REQUIRED with lastError", async () => {
    setWorkerEnv(["auth"], 300);
    setupNode();
    expect((await importReq()).statusCode).toBe(202);
    const final = await waitForState("AUTH_REQUIRED");
    expect(final.email).toBeNull();
    expect(final.lastError).toMatch(/session rejected/);
    // The stored file stays (re-import overwrites it), the state is the verdict.
    const view = await app.inject({ method: "GET", url: `/api/sessions/${accountId}` });
    expect(view.json().hasStoredFile).toBe(true);
  });

  it("hard error (no proxy node) -> AUTH_REQUIRED with the fail-closed reason", async () => {
    setWorkerEnv(["ok"]);
    // No node at all: the file is still accepted, but the background verify
    // fails closed and records the reason on the session row.
    expect((await importReq()).statusCode).toBe(202);
    const final = await waitForState("AUTH_REQUIRED");
    expect(final.lastError).toMatch(/fail-closed/);
    // The worker never even spawned (no tunnel to route through).
    expect(existsSync(stateFile())).toBe(false);
  });

  it("import-status returns 404 for an unknown account", async () => {
    const res = await importStatus("nope");
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("import-status reports UNKNOWN before any import happened", async () => {
    const res = await importStatus();
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ state: "UNKNOWN", email: null, lastError: null });
  });

  it("a concurrent import while one is in flight -> 409", async () => {
    setWorkerEnv(["ok"], 900);
    setupNode();
    expect((await importReq()).statusCode).toBe(202);
    const second = await importReq();
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe("conflict");
    // The first import still completes normally.
    const final = await waitForState("AUTHENTICATED");
    expect(final.email).toBe("fake@example.com");
  });

  it("the auth guard is released after completion (a fresh import can start)", async () => {
    setWorkerEnv(["ok"], 300);
    setupNode();
    expect((await importReq()).statusCode).toBe(202);
    await waitForState("AUTHENTICATED");
    const second = await importReq();
    expect(second.statusCode).toBe(202);
    const final = await waitForState("AUTHENTICATED");
    expect(final.email).toBe("fake@example.com");
  });

  it("close() drains an in-flight import before the provider/DB go away", async () => {
    setWorkerEnv(["ok"], 1000);
    setupNode();
    // Record session transitions to prove the verify finished inside close().
    const transitions: AuthSessionState[] = [];
    const orig = ctx.sessions.transition.bind(ctx.sessions);
    ctx.sessions.transition = (
      acc: string,
      provider: string,
      to: AuthSessionState,
      patch?: Parameters<typeof orig>[3],
    ): ReturnType<typeof orig> => {
      transitions.push(to);
      return orig(acc, provider, to, patch);
    };
    expect((await importReq()).statusCode).toBe(202);
    expect((await importStatus()).json().state).toBe("AUTH_IN_PROGRESS");
    const t0 = Date.now();
    await ctx.close();
    closedByTest = true;
    const elapsed = Date.now() - t0;
    // The drain waited for the ~1s background verify instead of abandoning it.
    expect(elapsed).toBeGreaterThan(500);
    expect(transitions).toContain("AUTH_IN_PROGRESS");
    expect(transitions).toContain("AUTHENTICATED");
    expect(transitions.at(-1)).toBe("AUTHENTICATED");
  });

  it("identity mismatch -> SESSION_INVALID and the account is never reassigned", async () => {
    setWorkerEnv(["ok"], 300);
    setupNode();
    const other = addAccount(ctx.accounts, "expected").id; // expected@example.com
    ctx.accounts.update(other, { status: "ACTIVE" });
    const res = await importReq(other);
    expect(res.statusCode).toBe(202);
    const final = await waitForState("SESSION_INVALID", other);
    expect(final.lastError).toMatch(/identity mismatch/);
    // The account keeps its own identity — the stranger's session never maps.
    expect(ctx.accounts.get(other)!.displayEmail).toBe("expected@example.com");
  });
});
