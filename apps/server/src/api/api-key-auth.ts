import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app-context.js";
import { COOKIE, parseCookies } from "./admin-auth.js";

/**
 * Job-surface gate for /api/jobs*:
 *
 * A request is allowed iff (first hit wins):
 *   1. the source IP is loopback or on NLO_TRUSTED_IPS,
 *   2. it carries a valid admin session cookie (browsers after /admin login;
 *      the cookie is Path=/, so the public SPA calls carry it too),
 *   3. it carries a valid API key (Authorization: Bearer nlo_…).
 *
 * Everything else is rejected with the standard 401 envelope. The gate is
 * always on: loopback keeps today's trust model bit-for-bit, and the admin
 * cookie keeps the SPA working in non-loopback deployments (Docker bridge).
 */

/** Normalize an IP for comparison: trim, lowercase, strip an IPv4-mapped prefix. */
function normalizeIp(ip: string): string {
  const t = ip.trim().toLowerCase();
  return t.startsWith("::ffff:") ? t.slice("::ffff:".length) : t;
}

/** Pure: loopback variants are always trusted, then exact match on the list. */
export function isTrustedIp(ip: string, trustedIps: string[]): boolean {
  const norm = normalizeIp(ip);
  if (norm === "127.0.0.1" || norm === "::1") return true;
  return trustedIps.some((t) => normalizeIp(t) === norm);
}

function isJobSurface(url: string): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return path === "/api/jobs" || path.startsWith("/api/jobs/");
}

/**
 * Attach the job-surface gate. Must be registered in buildApp alongside
 * guardAdminRoutes; the guarded prefixes are disjoint, so hook order is free.
 */
export function guardJobApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isJobSurface(req.url)) return;

    if (isTrustedIp(req.ip, ctx.config.trustedIps)) return;

    const token = parseCookies(req.headers.cookie)[COOKIE] ?? "";
    if (ctx.adminAuth.verify(token)) return;

    const header = req.headers.authorization;
    if (typeof header === "string") {
      const m = header.match(/^Bearer\s+(\S+)$/);
      if (m && ctx.apiKeys.verify(m[1])) return;
    }

    reply
      .code(401)
      .header("content-type", "application/json; charset=utf-8")
      .send({ error: { code: "unauthorized", message: "api key required" } });
  });
}
