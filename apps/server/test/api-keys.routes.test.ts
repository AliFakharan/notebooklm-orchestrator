import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { buildApp } from "../src/api/server.js";
import { makeAppContext } from "./helpers.js";
import type { AppContext } from "../src/app-context.js";

const ADMIN_USER = "admin";
const ADMIN_PASS = "correct-horse";
const FOREIGN = "203.0.113.7";

describe("api-key management routes", () => {
  let adminCtx: AppContext;
  let adminApp: FastifyInstance;
  let adminCookie: string;

  beforeEach(async () => {
    // An admin-gated app + a logged-in cookie, exactly the pattern of the
    // "admin gate" block in api.test.ts.
    adminCtx = await makeAppContext({ NLO_ADMIN_USER: ADMIN_USER, NLO_ADMIN_PASSWORD: ADMIN_PASS });
    adminApp = await buildApp(adminCtx);
    await adminApp.ready();
    const login = await adminApp.inject({
      method: "POST",
      url: "/api/admin/login",
      headers: { "content-type": "application/json" },
      payload: { username: ADMIN_USER, password: ADMIN_PASS },
    });
    expect(login.statusCode).toBe(200);
    const raw = login.headers["set-cookie"];
    adminCookie = (Array.isArray(raw) ? raw[0] : raw)!.split(";")[0]!;
  });

  afterEach(async () => {
    await adminApp.close();
    await adminCtx.close();
  });

  function cookie(): Record<string, string> {
    return { cookie: adminCookie };
  }

  async function create(name: string) {
    return adminApp.inject({
      method: "POST",
      url: "/api/api-keys",
      headers: { ...cookie(), "content-type": "application/json" },
      payload: JSON.stringify({ name }),
    });
  }

  it("create → 201 with the raw key", async () => {
    const res = await create("litellm");
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.key).toMatch(/^nlo_[A-Za-z0-9_-]{43}$/);
    expect(body.prefix).toBe(body.key.slice(0, 8));
    expect(body.name).toBe("litellm");
    expect(body.id).toMatch(/^ak_[0-9a-f]{16}$/);
    expect(body.createdAt).toBeTruthy();
  });

  it("the raw key is shown exactly once (list exposes prefix only)", async () => {
    const created = (await create("litellm")).json();
    const list = (
      await adminApp.inject({ method: "GET", url: "/api/api-keys", headers: cookie() })
    ).json();
    expect(JSON.stringify(list)).not.toContain(created.key);
    expect(JSON.stringify(list)).not.toContain("hash");
    expect(JSON.stringify(list)).toContain(created.prefix);
  });

  it("rejects invalid names with 400", async () => {
    for (const name of ["", "x".repeat(65)]) {
      const res = await create(name);
      expect(res.statusCode).toBe(400);
    }
  });

  it("revoke is idempotent; unknown id → 404", async () => {
    const created = (await create("litellm")).json();
    const first = await adminApp.inject({
      method: "POST",
      url: `/api/api-keys/${created.id}/revoke`,
      headers: cookie(),
    });
    expect(first.statusCode).toBe(200);
    const second = await adminApp.inject({
      method: "POST",
      url: `/api/api-keys/${created.id}/revoke`,
      headers: cookie(),
    });
    expect(second.statusCode).toBe(200);
    const missing = await adminApp.inject({
      method: "POST",
      url: "/api/api-keys/ak_deadbeefdeadbeef/revoke",
      headers: cookie(),
    });
    expect(missing.statusCode).toBe(404);
  });

  it("requires the admin cookie when the gate is enabled", async () => {
    expect((await adminApp.inject({ method: "GET", url: "/api/api-keys" })).statusCode).toBe(401);
  });

  it("a valid job key does NOT open /api/api-keys", async () => {
    // The key must be valid for adminCtx's own store (a separate DB from ctx):
    const k = adminCtx.apiKeys.create("litellm");
    const res = await adminApp.inject({
      method: "GET",
      url: "/api/api-keys",
      remoteAddress: FOREIGN,
      headers: { authorization: `Bearer ${k.raw}` },
    });
    expect(res.statusCode).toBe(401);
  });
});
