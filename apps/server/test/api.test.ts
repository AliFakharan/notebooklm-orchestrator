import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { addNode, makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

/**
 * API integration tests against the real Fastify app (loopback, ephemeral
 * port via inject()). Covers the error envelope, jobs, proxies
 * (secret masking), accounts, provider info, and settings.
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

describe("accounts", () => {
  it("creates, lists, patches, and deletes an account (secrets never exposed)", async () => {
    const created = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { label: "work", displayEmail: "w@example.com" },
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
        payload: { label: "def-a" },
      })
    ).json();
    const b = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { label: "def-b" },
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

  it("rejects browser-import for disallowed browsers and unknown accounts", async () => {
    const created = (
      await app.inject({
        method: "POST",
        url: "/api/accounts",
        headers: auth,
        payload: { label: "bi-1" },
      })
    ).json();

    // Disallowlist: the client must never pick an arbitrary executable.
    for (const browser of ["/usr/bin/google-chrome", "iexplore", "chrome; rm -rf /"]) {
      const res = await app.inject({
        method: "POST",
        url: `/api/sessions/${created.id}/browser-import`,
        headers: auth,
        payload: { browser },
      });
      expect(res.statusCode, browser).toBeGreaterThanOrEqual(400);
      expect(res.statusCode, browser).toBeLessThan(500);
    }

    // Unknown account: in mock mode the provider guard (400) fires first
    // (fail-closed); with the python-worker it is a clean 404. Either way:
    // a client error, never 500.
    const res = await app.inject({
      method: "POST",
      url: "/api/sessions/acc_missing/browser-import",
      headers: auth,
      payload: { browser: "chrome" },
    });
    expect(res.statusCode).toBeGreaterThanOrEqual(400);
    expect(res.statusCode).toBeLessThan(500);
  });

  it("rejects duplicate labels with a conflict-free envelope (no raw error leak)", async () => {
    await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { label: "dup" },
    });
    const dup = await app.inject({
      method: "POST",
      url: "/api/accounts",
      headers: auth,
      payload: { label: "dup" },
    });
    expect(dup.statusCode).toBeGreaterThanOrEqual(400);
    const body = dup.json();
    expect(body.error).toBeDefined();
    expect(body.error.code).toBeDefined();
    expect(JSON.stringify(body)).not.toContain("account label already exists");
  });
});

describe("jobs", () => {
  it("creates a job via multipart, lists it, and rejects bad extensions", async () => {
    // Create job (prompt only, no audio).
    const res = await mpInject(["prompt=hello"]);
    expect(res.statusCode).toBe(201);
    const job = res.json();
    expect(job.id).toMatch(/^j_[0-9a-f]{32}$/);
    expect(job.status).toBe("CREATED");

    const list = await app.inject({ method: "GET", url: "/api/jobs", headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.json().items.some((j: { id: string }) => j.id === job.id)).toBe(true);

    // A job detail endpoint returns it with its input.
    const detail = await app.inject({
      method: "GET",
      url: `/api/jobs/${job.id}`,
      headers: auth,
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().input.prompt).toBe("hello");

    // Unsupported extension rejected.
    const bad = await mpInject([
      "prompt=hello",
      { field: "audio", filename: "evil.exe", bytes: Buffer.from("x") },
    ]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("validation_error");

    // Missing prompt rejected.
    const np = await mpInject([]);
    expect(np.statusCode).toBe(400);
  });

  it("stores an uploaded wav into the job archive", async () => {
    const res = await mpInject([
      "prompt=transcribe",
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
    expect(detail.json().input.audio.originalName).toBe("talk.wav");
    expect(detail.json().input.audio.size).toBe(12);
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
        audio: { originalName: "", mediaType: "", size: 0, sha256: "", providerConfirmed: false },
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

    // Terminal job: requeue is rejected.
    const requeue = await app.inject({
      method: "POST",
      url: `/api/jobs/${job.id}/requeue`,
      headers: auth,
    });
    expect(requeue.statusCode).toBe(409);
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

describe("settings & secrets", () => {
  it("reads and updates whitelisted settings; lists secrets without values", async () => {
    const get = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(get.statusCode).toBe(200);
    expect(get.json().settings.jobsMaxAttemptsDefault).toBe(3);

    const put = await app.inject({
      method: "PUT",
      url: "/api/settings",
      headers: auth,
      payload: { jobsMaxAttemptsDefault: 5 },
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().updated).toContain("jobsMaxAttemptsDefault");

    const get2 = await app.inject({ method: "GET", url: "/api/settings", headers: auth });
    expect(get2.json().settings.jobsMaxAttemptsDefault).toBe(5);

    // A secret is visible as a masked ref + kind only.
    const node = await app.inject({
      method: "POST",
      url: "/api/proxies",
      headers: auth,
      payload: { uri: `vless://33333333-3333-3333-3333-333333333333@203.0.113.11:443#s1` },
    });
    expect(node.statusCode).toBe(201);
    const secrets = await app.inject({ method: "GET", url: "/api/secrets", headers: auth });
    const found = secrets
      .json()
      .secrets.find((s: { ref: string }) => s.ref.startsWith("vless-uuid:3333"));
    expect(found).toBeDefined();
    expect(found.kind).toBe("vless-uuid");
    // The full credential (the UUID after the colon) must not be exposed.
    expect(JSON.stringify(secrets.json())).not.toContain("33333333-3333-3333-3333-333333333333");
  });
});

describe("error envelope", () => {
  it("never leaks stack traces or raw messages for 404s/500s", async () => {
    const res = await app.inject({ method: "GET", url: "/api/nope", headers: auth });
    expect(res.statusCode).toBe(404);
    expect(res.json()).toEqual({ error: { code: "not_found", message: "not found" } });
  });
});
