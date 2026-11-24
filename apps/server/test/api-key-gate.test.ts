import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";
import { loadConfig } from "../src/config.js";
import { assertAdminConfigured } from "../src/api/admin-auth.js";
import { isTrustedIp } from "../src/api/api-key-auth.js";

const FOREIGN = "203.0.113.7";
const ADMIN_USER = "admin";
const ADMIN_PASS = "correct-horse";

/** Just the name=value portion of a set-cookie header. */
function cookieFrom(res: {
  headers: Record<string, string | number | string[] | undefined>;
}): string | undefined {
  const raw = res.headers["set-cookie"];
  if (!raw) return undefined;
  const full = Array.isArray(raw) ? raw[0] : typeof raw === "string" ? raw : undefined;
  return full?.split(";")[0];
}

describe("job-surface gate", () => {
  let ctx: AppContext;
  let app: FastifyInstance;
  let adminCtx: AppContext;
  let adminApp: FastifyInstance;
  let trustedCtx: AppContext;
  let trustedApp: FastifyInstance;
  let markerCtx: AppContext;
  let markerApp: FastifyInstance;

  beforeEach(async () => {
    ctx = await makeAppContext({});
    app = await buildApp(ctx);
    await app.ready();

    adminCtx = await makeAppContext({ NLO_ADMIN_USER: ADMIN_USER, NLO_ADMIN_PASSWORD: ADMIN_PASS });
    adminApp = await buildApp(adminCtx);
    await adminApp.ready();

    trustedCtx = await makeAppContext({ NLO_TRUSTED_IPS: FOREIGN });
    trustedApp = await buildApp(trustedCtx);
    await trustedApp.ready();

    // Admin-gated app with the reverse-proxy UI marker configured.
    markerCtx = await makeAppContext({
      NLO_ADMIN_USER: ADMIN_USER,
      NLO_ADMIN_PASSWORD: ADMIN_PASS,
      NLO_UI_MARKER_HEADER: "X-NLO-UI",
    });
    markerApp = await buildApp(markerCtx);
    await markerApp.ready();
  });

  afterEach(async () => {
    await app.close();
    await ctx.close();
    await adminApp.close();
    await adminCtx.close();
    await trustedApp.close();
    await trustedCtx.close();
    await markerApp.close();
    await markerCtx.close();
  });

  it("loopback needs no credentials (existing behavior preserved)", async () => {
    expect((await app.inject({ method: "GET", url: "/api/jobs" })).statusCode).toBe(200);
  });

  it("rejects a non-loopback caller without credentials with the 401 envelope", async () => {
    const res = await app.inject({ method: "GET", url: "/api/jobs", remoteAddress: FOREIGN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "api key required" } });
  });

  it("rejects malformed Authorization headers (Basic, empty Bearer, garbage)", async () => {
    for (const h of ["Basic abc", "Bearer", "Bearer ", "NTBearer x"]) {
      const res = await app.inject({
        method: "GET",
        url: "/api/jobs",
        remoteAddress: FOREIGN,
        headers: { authorization: h },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("accepts a valid Bearer key from a non-loopback caller and stamps last_used_at", async () => {
    const k = ctx.apiKeys.create("litellm");
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs",
      remoteAddress: FOREIGN,
      headers: { authorization: `Bearer ${k.raw}` },
    });
    expect(res.statusCode).toBe(200);
    expect(ctx.apiKeys.list()[0]!.lastUsedAt).not.toBeNull();
  });

  it("rejects a wrong key and a revoked key", async () => {
    const k = ctx.apiKeys.create("k");
    const wrong = await app.inject({
      method: "GET",
      url: "/api/jobs",
      remoteAddress: FOREIGN,
      headers: { authorization: `Bearer ${k.raw}0` },
    });
    expect(wrong.statusCode).toBe(401);
    ctx.apiKeys.revoke(k.id);
    const revoked = await app.inject({
      method: "GET",
      url: "/api/jobs",
      remoteAddress: FOREIGN,
      headers: { authorization: `Bearer ${k.raw}` },
    });
    expect(revoked.statusCode).toBe(401);
  });

  it("accepts a valid admin cookie from a foreign IP (Docker public-UI case)", async () => {
    // Mirror the "admin gate" block in api.test.ts: login on the admin-gated
    // app, take the cookie (first `;`-segment of set-cookie).
    const login = await adminApp.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "content-type": "application/json" },
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(login.statusCode).toBe(200);
    const adminCookie = cookieFrom(login);
    expect(adminCookie).toMatch(/^nlo_admin=[A-Za-z0-9_-]+$/);
    const res = await adminApp.inject({
      method: "GET",
      url: "/api/jobs",
      remoteAddress: FOREIGN,
      headers: { cookie: adminCookie },
    });
    expect(res.statusCode).toBe(200);
  });

  it("honors NLO_TRUSTED_IPS for an otherwise-foreign IP", async () => {
    expect(
      (await trustedApp.inject({ method: "GET", url: "/api/jobs", remoteAddress: FOREIGN }))
        .statusCode,
    ).toBe(200);
  });

  it("accepts a foreign caller carrying the configured UI marker (public UI via proxy)", async () => {
    const res = await markerApp.inject({
      method: "GET",
      url: "/api/jobs",
      remoteAddress: FOREIGN,
      headers: { "x-nlo-ui": "1" },
    });
    expect(res.statusCode).toBe(200);
  });

  it("rejects a foreign caller with a wrong or appended marker value", async () => {
    for (const v of ["0", "evil", "1,evil", "evil,1"]) {
      const res = await markerApp.inject({
        method: "GET",
        url: "/api/jobs",
        remoteAddress: FOREIGN,
        headers: { "x-nlo-ui": v },
      });
      expect(res.statusCode).toBe(401);
    }
  });

  it("ignores the marker header when NLO_UI_MARKER_HEADER is not configured", async () => {
    const res = await app.inject({
      method: "GET",
      url: "/api/jobs",
      remoteAddress: FOREIGN,
      headers: { "x-nlo-ui": "1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("the UI marker does NOT open the infrastructure API", async () => {
    const res = await markerApp.inject({
      method: "GET",
      url: "/api/accounts",
      remoteAddress: FOREIGN,
      headers: { "x-nlo-ui": "1" },
    });
    expect(res.statusCode).toBe(401);
  });

  it("keeps /api/health open to non-loopback callers", async () => {
    expect(
      (await app.inject({ method: "GET", url: "/api/health", remoteAddress: FOREIGN })).statusCode,
    ).toBe(200);
  });

  it("a job key does NOT open the infrastructure API", async () => {
    // The key must be valid for adminCtx's own store (a separate DB from ctx):
    const k = adminCtx.apiKeys.create("litellm");
    const res = await adminApp.inject({
      method: "GET",
      url: "/api/accounts",
      remoteAddress: FOREIGN,
      headers: { authorization: `Bearer ${k.raw}` },
    });
    expect(res.statusCode).toBe(401);
  });

  it("a job key DOES open /api/sessions (Bale bot cookie import)", async () => {
    const k = ctx.apiKeys.create("bot");
    const res = await app.inject({
      method: "GET",
      url: "/api/sessions",
      remoteAddress: FOREIGN,
      headers: { authorization: `Bearer ${k.raw}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveProperty("sessions");
  });

  it("rejects /api/sessions from a foreign caller without credentials", async () => {
    const res = await app.inject({ method: "GET", url: "/api/sessions", remoteAddress: FOREIGN });
    expect(res.statusCode).toBe(401);
    expect(res.json()).toEqual({ error: { code: "unauthorized", message: "api key required" } });
  });
});

describe("isTrustedIp", () => {
  it("trusts loopback variants and nothing else by default", () => {
    expect(isTrustedIp("127.0.0.1", [])).toBe(true);
    expect(isTrustedIp("::1", [])).toBe(true);
    expect(isTrustedIp("::ffff:127.0.0.1", [])).toBe(true);
    expect(isTrustedIp("172.17.0.1", [])).toBe(false);
    expect(isTrustedIp("172.17.0.1", ["172.17.0.1", " 10.0.0.5 "])).toBe(true);
  });
});

describe("assertAdminConfigured", () => {
  const enabledConfig = loadConfig({ NLO_ADMIN_USER: "u", NLO_ADMIN_PASSWORD: "p" });
  const disabledConfig = loadConfig({ NLO_ADMIN_USER: "", NLO_ADMIN_PASSWORD: "" });

  it("passes when the gate is enabled", () => {
    expect(() => assertAdminConfigured(enabledConfig)).not.toThrow();
  });

  it("throws with a clear message when disabled", () => {
    expect(() => assertAdminConfigured(disabledConfig)).toThrow(/NLO_ADMIN_USER/);
  });
});
