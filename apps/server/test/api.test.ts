import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { addNode, makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

/**
 * API integration tests against the real Fastify app (loopback, ephemeral
 * port via inject()). Covers the error envelope, jobs, proxies
 * (secret masking), accounts, and provider info.
 *
 * Note: the app's background queue is stopped in the test context so HTTP
 * tests never race with job execution (covered by runner/queue tests).
 */

let ctx: AppContext;
let app: FastifyInstance;
// Local single-user model: no bearer token — the header is kept as an empty
// object so call sites stay uniform.
const auth: Record<string, string> = {};
const MP_BOUNDARY = "----nlo-test-boundary";

beforeEach(async () => {
  ctx = await makeAppContext({});
  app = await buildApp(ctx);
  await app.ready();
});

afterEach(async () => {
  await app.close();
  await ctx.close();
});

type MpPart = string | { field: string; filename?: string; bytes?: Buffer; type?: string };

/** Build a correct multipart/form-data body (CRLF-terminated parts). */
function multipart(parts: MpPart[]): Buffer {
  const chunks: Buffer[] = [];
  for (const part of parts) {
    if (typeof part === "string") {
      // name=value field pair (value may be empty).
      const eq = part.indexOf("=");
      const name = part.slice(0, eq);
      const value = part.slice(eq + 1);
      chunks.push(
        Buffer.from(
          `--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
        ),
      );
    } else {
      const header = `--${MP_BOUNDARY}\r\ncontent-disposition: form-data; name="${part.field}"; filename="${part.filename ?? "upload.bin"}"\r\ncontent-type: ${part.type ?? "application/octet-stream"}\r\n\r\n`;
      chunks.push(Buffer.from(header));
      if (part.bytes && part.bytes.length > 0) chunks.push(part.bytes);
      chunks.push(Buffer.from("\r\n"));
    }
  }
  chunks.push(Buffer.from(`--${MP_BOUNDARY}--\r\n`));
  return Buffer.concat(chunks);
}

function mpInject(parts: MpPart[]) {
  return app.inject({
    method: "POST",
    url: "/api/jobs",
    headers: { ...auth, "content-type": `multipart/form-data; boundary=${MP_BOUNDARY}` },
    payload: multipart(parts),
  });
}

describe("health", () => {
  it("exposes readiness without auth", async () => {
    const health = await app.inject({ method: "GET", url: "/api/health" });
    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
  });
});

describe("admin gate", () => {
  // A second app instance with admin credentials configured: the
  // infrastructure API must require a session cookie, while /api/admin/*
  // and the public job/health routes stay open.
  let adminCtx: AppContext;
  let adminApp: FastifyInstance;
  const ADMIN_USER = "admin";
  const ADMIN_PASS = "correct-horse";

  beforeEach(async () => {
    adminCtx = await makeAppContext({
      NLO_ADMIN_USER: ADMIN_USER,
      NLO_ADMIN_PASSWORD: ADMIN_PASS,
    });
    adminApp = await buildApp(adminCtx);
    await adminApp.ready();
  });

  afterEach(async () => {
    await adminApp.close();
    await adminCtx.close();
  });

  function setCookie(res: {
    headers: Record<string, string | number | string[] | undefined>;
  }): string | undefined {
    const raw = res.headers["set-cookie"];
    if (!raw) return undefined;
    return Array.isArray(raw) ? raw[0] : typeof raw === "string" ? raw : undefined;
  }

  /** Just the name=value portion (the actual cookie value to send back). */
  function cookieFrom(res: {
    headers: Record<string, string | number | string[] | undefined>;
  }): string | undefined {
    const full = setCookie(res);
    return full?.split(";")[0];
  }

  it("rejects infrastructure calls without a cookie, allows after login", async () => {
    // Locked out before login.
    const locked = await adminApp.inject({ method: "GET", url: "/api/accounts", headers: auth });
    expect(locked.statusCode).toBe(401);
    expect(locked.json().error.code).toBe("unauthorized");
    const lockedProxy = await adminApp.inject({
      method: "GET",
      url: "/api/proxies",
      headers: auth,
    });
    expect(lockedProxy.statusCode).toBe(401);

    // Public routes are unaffected by the gate.
    const jobs = await adminApp.inject({ method: "GET", url: "/api/jobs", headers: auth });
    expect(jobs.statusCode).toBe(200);

    // Wrong password is rejected.
    const bad = await adminApp.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "content-type": "application/json" },
      payload: { username: ADMIN_USER, password: "wrong" },
    });
    expect(bad.statusCode).toBe(401);
    expect(cookieFrom(bad)).toBeUndefined();

    // Wrong username is rejected too.
    const badUser = await adminApp.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "content-type": "application/json" },
      payload: { username: "nope", password: ADMIN_PASS },
    });
    expect(badUser.statusCode).toBe(401);

    // Correct credentials issue a session cookie.
    const ok = await adminApp.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "content-type": "application/json" },
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().gated).toBe(true);
    const setCookieValue = setCookie(ok);
    expect(setCookieValue).toMatch(/^nlo_admin=[A-Za-z0-9_-]+/);
    expect(setCookieValue).toContain("HttpOnly");
    expect(setCookieValue).toContain("SameSite=Strict");
    const cookie = cookieFrom(ok);
    expect(cookie).toMatch(/^nlo_admin=[A-Za-z0-9_-]+$/);

    // The cookie unlocks the infrastructure.
    const unlocked = await adminApp.inject({
      method: "GET",
      url: "/api/accounts",
      headers: { cookie },
    });
    expect(unlocked.statusCode).toBe(200);

    // /api/admin/me reflects the session.
    const me = await adminApp.inject({ method: "GET", url: "/api/admin/me", headers: { cookie } });
    expect(me.statusCode).toBe(200);
    expect(me.json()).toEqual({ enabled: true, authenticated: true });

    // Logout clears the cookie and locks again.
    const out = await adminApp.inject({
      method: "POST",
      url: "/api/admin/logout",
      headers: { cookie },
    });
    expect(out.statusCode).toBe(200);
    expect(setCookie(out)).toContain("Max-Age=0");
    const after = await adminApp.inject({
      method: "GET",
      url: "/api/accounts",
      headers: { cookie },
    });
    expect(after.statusCode).toBe(401);
  });

  it("is a no-op (gated:false) when no admin credentials are configured", async () => {
    // The default app (this file's `app`) has no admin env: the login route
    // short-circuits and the infrastructure stays open.
    const me = await app.inject({ method: "GET", url: "/api/admin/me", headers: auth });
    expect(me.json()).toEqual({ enabled: false, authenticated: true });
    const accounts = await app.inject({ method: "GET", url: "/api/accounts", headers: auth });
    expect(accounts.statusCode).toBe(200);
  });
});

describe("accounts", () => {
  it("creates, lists, patches, and deletes an account (secrets never exposed)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { email: "w@example.com" },
    });
    expect(created.statusCode).toBe(201);
    const acc = created.json();
    expect(acc.id).toMatch(/^acc_/);
    expect(acc.hasAuth).toBe(false);
    expect(acc.authSecretRef).toBeUndefined();

    const list = await app.inject({ method: "GET", url: "/api/accounts", headers: auth });
    expect(list.json().some((a: { id: string }) => a.id === acc.id)).toBe(true);

    const patched = await app.inject({
      method: "PATCH",
      url: `/api/accounts/${acc.id}`,
      headers: auth,
      payload: { status: "ACTIVE" },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().status).toBe("ACTIVE");

    const del = await app.inject({
      method: "DELETE",
      url: `/api/accounts/${acc.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    const gone = await app.inject({ method: "GET", url: `/api/accounts/${acc.id}`, headers: auth });
    expect(gone.statusCode).toBe(404);
  });

  it("supports a single default account with an exclusive invariant", async () => {
    const a = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "def-a@example.com" },
      })
    ).json();
    const b = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "def-b@example.com" },
      })
    ).json();

    const setA = await app.inject({
      method: "POST",
      url: `/api/accounts/${a.id}/default`,
      headers: auth,
      payload: { isDefault: true },
    });
    expect(setA.statusCode).toBe(200);
    expect(setA.json().isDefault).toBe(true);

    // Setting a second default clears the first.
    const setB = await app.inject({
      method: "POST",
      url: `/api/accounts/${b.id}/default`,
      headers: auth,
      payload: { isDefault: true },
    });
    expect(setB.json().isDefault).toBe(true);
    const list = await app.inject({ method: "GET", url: "/api/accounts", headers: auth });
    const rowA = list.json().find((x: { id: string }) => x.id === a.id);
    const rowB = list.json().find((x: { id: string }) => x.id === b.id);
    expect(rowA.isDefault).toBe(false);
    expect(rowB.isDefault).toBe(true);

    // Clearing works.
    const clear = await app.inject({
      method: "POST",
      url: `/api/accounts/${b.id}/default`,
      headers: auth,
      payload: { isDefault: false },
    });
    expect(clear.statusCode).toBe(200);
    expect(clear.json().isDefault).toBe(false);

    // Validation: bad body rejected.
    const bad = await app.inject({
      method: "POST",
      url: `/api/accounts/${b.id}/default`,
      headers: auth,
      payload: { isDefault: "yes" },
    });
    expect(bad.statusCode).toBeGreaterThanOrEqual(400);
  });

  it("rejects malformed cookie imports without touching the session (client errors)", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "ci-1@example.com" },
      })
    ).json();

    // No provider configured (mock): the worker guard fires (400) — the
    // parsing layer is unit-tested in cookie-import.test.ts. Assert the
    // envelope is a clean client error, never a 500, for empty input and
    // for an unknown account.
    for (const payload of [{}, { cookies: "   " }]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.id}/import`,
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBeGreaterThanOrEqual(400);
      expect(res.statusCode).toBeLessThan(500);
    }

    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/acc_missing/import",
      headers: auth,
      payload: { cookies: "[]" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("rejects duplicate emails with a conflict-free envelope (no raw error leak)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { email: "dup@example.com" },
    });
    const dup = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { email: "DUP@example.com" }, // uniqueness is case-insensitive
    });
    expect(dup.statusCode).toBe(409);
    const body = dup.json();
    expect(body.error.code).toBe("conflict");
    // no raw repo error and no PII leak
    expect(JSON.stringify(body)).not.toContain("already exists: dup@example.com");
    expect(JSON.stringify(body)).not.toContain("dup@example.com");
  });
});

describe("jobs", () => {
  it("creates a job via multipart, lists it, and rejects bad extensions", async () => {
    // With no account registered, job creation is rejected up front.
    const noAccount = await mpInject(["prompt=hello"]);
    expect(noAccount.statusCode).toBe(400);
    expect(noAccount.json().error.code).toBe("validation_error");

    const acc = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "job@example.com" },
      })
    ).json();

    // The account is chosen automatically (default account); the request no
    // longer carries preferredAccountId.
    const res = await mpInject(["prompt=hello"]);
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.id).toMatch(/^j_[0-9a-f]{32}$/);
    expect(job.status).toBe("CREATED");

    const list = await app.inject({ method: "GET", url: "/api/jobs", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((j: { id: string }) => j.id === job.id)).toBe(true);

    // A job detail endpoint returns it with its input (account auto-picked).
    const detail = await app.inject({
      method: "GET",
      url: `/api/jobs/${job.id}`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().input.prompt).toBe("hello");
    expect(detail.json().input.preferredAccountId).toBeNull(); // auto-selected at run time

    // Unsupported extension rejected.
    const bad = await mpInject([
      "prompt=hello",
      `preferredAccountId=${acc.id}`,
      { field: "audio", filename: "evil.exe", bytes: Buffer.from("x") },
    ]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");

    // Missing prompt rejected.
    const np = await mpInject([]);
    expect(np.statusCode).toBe(400);
  });

  it("stores an uploaded wav into the job archive", async () => {
    const acc = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { email: "wav@example.com" },
      })
    ).json();
    const res = await mpInject([
      "prompt=transcribe",
      `preferredAccountId=${acc.id}`,
      {
        field: "audio",
        filename: "talk.wav",
        bytes: Buffer.from("RIFF....fake"),
        type: "audio/wav",
      },
    ]);
    expect(res.statusCode).toBe(201);
    const job = res.json();
    const detail = await app.inject({ method: "GET", url: `/api/jobs/${job.id}`, headers: auth });
    expect(detail.json().input.sources[0].originalName).toBe("talk.wav");
    expect(detail.json().input.sources[0].size).toBe(12);
  });

  it("404s for unknown job ids with the standard envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs/j_deadbeef", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("not_found");
  });

  it("cancel/requeue respect the state machine", async () => {
    const job = ctx.jobs.create({
      input: {
        prompt: "x",
        sources: [],
        preferredAccountId: null,
        preferredNodeId: null,
      },
      configSnapshot: {},
    });
    const cancel = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/cancel`,
      headers: auth,
    });
    expect(cancel.statusCode).toBe(200);
    expect(cancel.json().status).toBe("CANCELLED"); // CREATED -> CANCELLED directly

    // Cancelled job: requeue is rejected (CANCELLED has no way out).
    const requeue = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/requeue`,
      headers: auth,
    });
    expect(requeue.statusCode).toBe(409);
  });

  it("FAILED jobs can be retried: reset attempt budget, clear error + node", async () => {
    const { id: nodeId } = addNode(ctx.proxies, ctx.vault, "retry-node");
    const job = ctx.jobs.create({
      input: {
        prompt: "x",
        sources: [],
        preferredAccountId: null,
        preferredNodeId: null,
      },
      configSnapshot: {},
    });
    ctx.jobs.setStatus(job.id, "VALIDATING");
    ctx.jobs.setStatus(job.id, "FAILED", {
      errorClass: "auth",
      errorMessage: "session not verified",
      attempt: 2,
      nodeId,
    });
    const retried = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/requeue`,
      headers: auth,
    });
    expect(retried.statusCode).toBe(200);
    expect(retried.json().status).toBe("QUEUED");
    const after = ctx.jobs.get(job.id)!;
    expect(after.attempt).toBe(0);
    expect(after.errorClass).toBeNull();
    expect(after.errorMessage).toBeNull();
    expect(after.nodeId).toBeNull();
    expect(after.input.preferredAccountId).toBeNull(); // same inputs preserved
  });
});

describe("proxies", () => {
  const uuid = "22222222-2222-2222-2222-222222222222";
  const uri = `vless://${uuid}@203.0.113.10:443?type=tcp&security=none#test-node`;

  it("creates a node from a URI and NEVER returns the raw UUID", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: auth,
      payload: { uri },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.node.config.uuidMasked).toBe("••••-••••-••••-2222");
    expect(JSON.stringify(body)).not.toContain(uuid);
    // The secret is vaulted, not in the row.
    expect(ctx.vault.has(`vless-uuid:${uuid}`)).toBe(true);
  });

  it("rejects malformed URIs with a validation error", async () => {
    const res = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: auth,
      payload: { uri: "not-a-vless-uri" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("validation_error");
  });

  it("batch-imports a multi-URI clipboard blob with per-line results and dedupe", async () => {
    const u2 = "23333333-2323-4333-8333-555555555555";
    const blob = [
      `vless://${uuid}@203.0.113.20:443?security=tls&type=ws&path=%2Fa#node-a`,
      "definitely-not-a-uri",
      `vless://${u2}@203.0.113.21:443#node-b`,
      // duplicate of the first line (same connection identity)
      `vless://${uuid}@203.0.113.20:443?security=tls&type=ws&path=%2Fa#node-a-again`,
    ].join("\n");

    const res = await app.inject({
      method: "POST",
      url: "/api/proxies/import",
      headers: auth,
      payload: { text: blob },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      total: number;
      added: number;
      skipped: number;
      errors: number;
      results: { line: number; status: string; reason?: string }[];
    };
    expect(body.total).toBe(4);
    expect(body.added).toBe(2);
    expect(body.skipped).toBe(1);
    expect(body.errors).toBe(1);
    expect(body.results.map((r) => r.status)).toEqual(["added", "error", "added", "skipped"]);
    // Per-line errors carry a real message, not a bare failure.
    expect(body.results[1]!.reason).toBeTruthy();
    // Raw UUIDs never appear in the response.
    expect(JSON.stringify(body)).not.toContain(uuid);
    expect(JSON.stringify(body)).not.toContain(u2);
    // Both secrets are vaulted.
    expect(ctx.vault.has(`vless-uuid:${uuid}`)).toBe(true);
    expect(ctx.vault.has(`vless-uuid:${u2}`)).toBe(true);

    // Re-importing the same blob skips everything (identity dedupe vs DB).
    const again = await app.inject({
      method: "POST",
      url: "/api/proxies/import",
      headers: auth,
      payload: { text: blob },
    });
    expect(again.statusCode).toBe(200);
    const body2 = again.json() as { added: number; skipped: number };
    expect(body2.added).toBe(0);
    expect(body2.skipped).toBe(3);

    // Empty / garbage input is a validation error, not a silent success.
    const empty = await app.inject({
      method: "POST",
      url: "/api/proxies/import",
      headers: auth,
      payload: { text: "   \n  " },
    });
    expect(empty.statusCode).toBe(400);
    expect(empty.json().error.code).toBe("validation_error");
  });

  it("lists nodes with masked config and deletes (removing the vault secret)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: auth,
      payload: { uri },
    });
    const node = created.json().node as { id: string };
    expect(ctx.vault.has(`vless-uuid:${uuid}`)).toBe(true);

    const list = await app.inject({ method: "GET", url: "/api/proxies", headers: auth });
    expect(list.json().some((n: { id: string }) => n.id === node.id)).toBe(true);
    expect(JSON.stringify(list.json())).not.toContain(uuid);

    const del = await app.inject({
      method: "DELETE",
      url: `/api/proxies/${node.id}`,
      headers: auth,
    });
    expect(del.statusCode).toBe(204);
    expect(ctx.vault.has(`vless-uuid:${uuid}`)).toBe(false);
  });

  it("batch-deletes selected nodes and cleans up unreferenced vault secrets", async () => {
    const u2 = "44444444-4444-4444-4444-444444444444";
    const a = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: auth,
      payload: { uri: `vless://${uuid}@203.0.113.30:443#del-a` },
    });
    const b = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: auth,
      payload: { uri: `vless://${u2}@203.0.113.31:443#del-b` },
    });
    expect(a.statusCode).toBe(201);
    expect(b.statusCode).toBe(201);
    const idA = (a.json().node as { id: string }).id;
    const idB = (b.json().node as { id: string }).id;

    const res = await app.inject({
      method: "DELETE",
      url: "/api/proxies",
      headers: auth,
      payload: { ids: [idA, idB, "node_does_not_exist"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ deleted: 2 });

    const list = await app.inject({ method: "GET", url: "/api/proxies", headers: auth });
    const ids = (list.json() as { id: string }[]).map((n) => n.id);
    expect(ids).not.toContain(idA);
    expect(ids).not.toContain(idB);
    // Both secrets had no remaining references — vault cleaned up.
    expect(ctx.vault.has(`vless-uuid:${uuid}`)).toBe(false);
    expect(ctx.vault.has(`vless-uuid:${u2}`)).toBe(false);

    // Empty id list is rejected, not a silent no-op.
    const empty = await app.inject({
      method: "DELETE",
      url: "/api/proxies",
      headers: auth,
      payload: { ids: [] },
    });
    expect(empty.statusCode).toBe(400);
  });

  it("ping-all checks every node and persists per-node health rows", async () => {
    // Isolated context: fixed-IP allowlist (no notebooklm.google.com) so
    // destination selection is deterministic; xray runtime WITHOUT its
    // binary so every staged check fails fast at the runtime stage — no
    // network I/O. This asserts endpoint semantics and persistence.
    const ctx2 = await makeAppContext({
      NLO_HEALTH_ALLOWLIST: "93.184.216.34:443",
      NLO_PROXY_RUNTIME: "xray",
    });
    const app2 = await buildApp(ctx2);
    await app2.ready();
    try {
      addNode(ctx2.proxies, ctx2.vault, "ping-a");
      const b = addNode(ctx2.proxies, ctx2.vault, "ping-b");

      const res = await app2.inject({
        method: "POST",
        url: "/api/proxies/ping-all",
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        at: string;
        target: string;
        results: { id: string; ok: boolean; latencyMs: number | null; error: string | null }[];
      };
      expect(typeof body.at).toBe("string");
      // Allowlist has no notebooklm.google.com, so the first entry is used.
      expect(body.target).toBe("93.184.216.34:443");
      const ids = new Set(ctx2.proxies.list().map((n) => n.id));
      expect(body.results.length).toBe(ids.size);
      for (const r of body.results) expect(ids.has(r.id)).toBe(true);
      // Runtime is not configured, so every node gets a (failed) verdict.
      for (const r of body.results) {
        expect(r.ok).toBe(false);
        expect(r.error ?? "").toContain("Xray binary is not installed");
      }

      // Each node's health row was persisted (freshness the UI can display).
      const got = await app2.inject({ method: "GET", url: `/api/proxies/${b.id}`, headers: auth });
      expect(got.json().health.lastCheckedAt).toBeTypeOf("string");
    } finally {
      await app2.close();
      await ctx2.close();
    }
  });

  it("per-node health response carries the persisted health row (UI merge)", async () => {
    // Isolated context: no xray binary -> every staged check fails fast
    // without network I/O; what matters here is the RESPONSE SHAPE: the UI
    // merges `node` straight into its list, so it must include `health`
    // (a bare maskNode would wipe the row back to "never checked").
    const ctx3 = await makeAppContext({
      NLO_HEALTH_ALLOWLIST: "93.184.216.34:443",
      NLO_PROXY_RUNTIME: "xray",
    });
    const app3 = await buildApp(ctx3);
    await app3.ready();
    try {
      const n = addNode(ctx3.proxies, ctx3.vault, "shape-a");
      const res = await app3.inject({
        method: "POST",
        url: `/api/proxies/${n.id}/health`,
        headers: auth,
        payload: { target: "egress" },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as {
        node: { health?: { lastCheckedAt?: string | null; ok?: boolean } | null };
      };
      expect(body.node.health).toBeTruthy();
      expect(body.node.health!.lastCheckedAt).toBeTypeOf("string");
      // The failure is real (no xray), so the merged row shows "no answer",
      // not "never tested".
      expect(body.node.health!.ok).toBe(false);
    } finally {
      await app3.close();
      await ctx3.close();
    }
  });
});

describe("provider info", () => {
  it("reports the mock provider with an honest capability matrix", async () => {
    const res = await app.inject({ method: "GET", url: "/api/provider", headers: auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe("mock");
    expect(body.isMock).toBe(true);
    expect(body.liveDisabled).toBe(true);
    const ops = body.capabilities.map((c: { operation: string }) => c.operation);
    expect(ops).toContain("uploadAudioSource");
    expect(ops).toContain("ask");
    const levels = new Set(body.capabilities.map((c: { level: string }) => c.level));
    // Mock must not claim live capability.
    expect(levels.has("implemented_untested_live")).toBe(false);
  });
});

describe("error envelope", () => {
  it("never leaks stack traces or raw messages for 404s/500s", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });
});
