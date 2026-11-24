import type { FastifyInstance } from "fastify";
import type { AppContext } from "../app-context.js";
import { COOKIE, parseCookies } from "./admin-auth.js";

/**
 * Key-gated surface gate for /api/jobs* and /api/sessions*:
 *
 * A request is allowed iff (first hit wins):
 *   1. the source IP is loopback or on NLO_TRUSTED_IPS,
 *   2. it carries the reverse-proxy UI marker (NLO_UI_MARKER_HEADER: the
 *      operator's Caddy strips client values and sets it only on the public
 *      UI site, so marked requests are same-origin SPA traffic),
 *   3. it carries a valid admin session cookie (browsers after /admin login;
 *      the cookie is Path=/, so the public SPA calls carry it too),
 *   4. it carries a valid API key (Authorization: Bearer nlo_…).
 *
 * The sessions surface is key-gated (not admin-gated) so the Bale bot can
 * import/verify Google session cookies with its API key. Everything else is
 * rejected with the standard 401 envelope. The gate is always on: loopback
 * keeps today's trust model bit-for-bit, and the admin cookie keeps the SPA
 * working in non-loopback deployments (Docker bridge).
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

/** Surfaces reachable with a Bearer API key (machine-to-machine clients). */
const KEY_GATED_PREFIXES = ["/api/jobs", "/api/sessions"];

function isKeyGatedSurface(url: string): boolean {
  const path = (url ?? "").split("?")[0] ?? "";
  return KEY_GATED_PREFIXES.some((p) => path === p || path.startsWith(`${p}/`));
}

/**
 * Attach the key-gated surface gate. Must be registered in buildApp alongside
 * guardAdminRoutes; /api/sessions is removed from the admin gate's protected
 * prefixes (see admin-auth.ts) so this gate is the sole authority for it.
 */
export function guardJobApiRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.addHook("onRequest", async (req, reply) => {
    if (!isKeyGatedSurface(req.url)) return;

    if (isTrustedIp(req.ip, ctx.config.trustedIps)) return;

    const marker = ctx.config.uiMarkerHeader;
    if (marker !== null && req.headers[marker.toLowerCase()] === "1") return;

    const token = parseCookies(req.headers.cookie)[COOKIE] ?? "";
    if (ctx.adminAuth.verify(token)) return;

    const header = req.headers.authorization;
    if (typeof header === "string") {
      const m = header.match(/^Bearer\s+(\S+)$/);
      if (m?.[1] && ctx.apiKeys.verify(m[1])) return;
    }

    reply
      .code(401)
      .header("content-type", "application/json; charset=utf-8")
      .send({ error: { code: "unauthorized", message: "api key required" } });
  });
}
