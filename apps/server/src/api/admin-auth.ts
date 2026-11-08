import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../app-context.js";

/**
 * Admin gate for the infrastructure API (accounts / proxies / sessions).
 *
 * - Credentials come from env (`NLO_ADMIN_USER` / `NLO_ADMIN_PASSWORD`). When
 *   either is unset the gate is DISABLED and the infrastructure endpoints are
 *   open (local single-user/dev default; keeps existing behavior).
 * - When enabled, `POST /api/admin/login` (username + password) issues an
 *   HttpOnly, SameSite=Strict cookie (`nlo_admin`) carrying a random session
 *   token; the token -> expiry map is kept in memory (single-user, loopback
 *   app: process restart logs everyone out — intended). `GET /api/admin/me`
 *   reports auth state; `POST /api/admin/logout` clears it.
 * - `guardAdminRoutes(app, ctx)` attaches an onRequest hook that rejects every
 *   request under /api/accounts, /api/proxies, /api/sessions with 401 when the
 *   cookie is absent/invalid/expired (and the gate is enabled).
 *
 * Password comparison is timing-safe (SHA-256 both sides, then
 * timingSafeEqual) so a wrong password is not distinguishable by timing.
 */

export const COOKIE = "nlo_admin";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

export interface AdminAuth {
  enabled: boolean;
  readonly user: string;
  login(password: string): { token: string; expiresMs: number } | null;
  verify(token: string): boolean;
  logout(token: string): void;
}

function timingSafeEq(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function createAdminAuth(config: AppContext["config"]): AdminAuth {
  const user = config.admin.user;
  const password = config.admin.password;
  const enabled = config.admin.enabled;
  const sessions = new Map<string, number>(); // token -> expiresAt (epoch ms)

  function sweep(now: number): void {
    for (const [t, exp] of sessions) if (exp <= now) sessions.delete(t);
  }

  return {
    enabled,
    user,
    login(pass: string): { token: string; expiresMs: number } | null {
      if (!enabled) return null;
      if (!timingSafeEq(pass, password)) return null;
      const now = Date.now();
      sweep(now);
      const token = randomBytes(32).toString("base64url");
      const expiresMs = now + SESSION_TTL_MS;
      sessions.set(token, expiresMs);
      return { token, expiresMs };
    },
    verify(token: string): boolean {
      if (!enabled || !token) return false;
      const exp = sessions.get(token);
      if (!exp) return false;
      const now = Date.now();
      if (exp <= now) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    logout(token: string): void {
      sessions.delete(token);
    },
  };
}

/**
 * Production gate: the server must run with the admin gate enabled
 * (keys + infrastructure API). The disabled-gate mode is test/programmatic
 * only; main.ts calls this at startup and refuses to boot when it throws.
 */
export function assertAdminConfigured(config: AppContext["config"]): void {
  if (!config.admin.enabled) {
    throw new Error(
      "admin credentials are required: set NLO_ADMIN_USER and NLO_ADMIN_PASSWORD in your .env",
    );
  }
}

export function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!cookieHeader) return out;
  for (const part of cookieHeader.split(";")) {
    const i = part.indexOf("=");
    if (i <= 0) continue;
    const k = part.slice(0, i).trim();
    const v = part.slice(i + 1).trim();
    if (k) out[k] = v;
  }
  return out;
}

/** Build a full Set-Cookie value (Fastify v5 has no reply.setCookie). */
function setCookieHeader(name: string, value: string, maxAgeSec: number): string {
  return `${name}=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSec}`;
}

/** Register /api/admin/login, /api/admin/logout, /api/admin/me. */
export function registerAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  const auth = ctx.adminAuth;

  app.post("/api/admin/login", async (req, reply) => {
    if (!auth.enabled) {
      // Gate disabled: behave like a successful no-op so the UI works everywhere.
      return { ok: true, gated: false };
    }
    const body = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    // Compare the password even when the username is wrong (constant work path
    // is not required at this strength for a loopback app; both are checked).
    const session = username === auth.user ? auth.login(password) : null;
    if (!session) {
      throw new ApiError(ApiCodes.unauthorized, "نام کاربری یا رمز اشتباه است", 401);
    }
    const maxAgeSec = Math.floor((session.expiresMs - Date.now()) / 1000);
    reply.header("set-cookie", setCookieHeader(COOKIE, session.token, maxAgeSec));
    return { ok: true, gated: true };
  });

  app.post("/api/admin/logout", async (req, reply) => {
    const token = parseCookies(req.headers.cookie)[COOKIE] ?? "";
    auth.logout(token);
    reply.header("set-cookie", setCookieHeader(COOKIE, "", 0));
    return { ok: true };
  });

  app.get("/api/admin/me", async (req) => {
    const token = parseCookies(req.headers.cookie)[COOKIE] ?? "";
    return { enabled: auth.enabled, authenticated: auth.enabled ? auth.verify(token) : true };
  });
}

const PROTECTED_PREFIXES = ["/api/accounts", "/api/proxies", "/api/sessions", "/api/api-keys"];

function isProtected(url: string): boolean {
  return PROTECTED_PREFIXES.some((p) => url === p || url.startsWith(`${p}/`));
}

/**
 * Reject unauthenticated infrastructure API calls when the gate is enabled.
 * Must be registered AFTER the admin routes (so /api/admin/* is reachable) —
 * it only guards the protected prefixes listed above.
 */
export function guardAdminRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!ctx.adminAuth.enabled) return;
    const url = (req.url ?? "").split("?")[0] ?? "";
    if (!isProtected(url)) return;
    const token = parseCookies(req.headers.cookie)[COOKIE] ?? "";
    if (!ctx.adminAuth.verify(token)) {
      reply
        .code(401)
        .header("content-type", "application/json; charset=utf-8")
        .send({ error: { code: "unauthorized", message: "admin login required" } });
    }
  });
}
