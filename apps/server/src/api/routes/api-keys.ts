import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";

/**
 * API-key management (admin-gated via guardAdminRoutes' /api/api-keys prefix).
 * The raw key is returned exactly once, by POST /api/api-keys.
 */

const createKey = z.object({
  name: z.string().trim().min(1).max(64),
});

const ADMIN_SECURITY = [{ adminCookie: [] }];

/** Key metadata as listed — NEVER carries the raw key. */
const apiKeyInfoSchema = {
  type: "object",
  required: ["id", "name", "prefix", "createdAt"],
  properties: {
    id: { type: "string" },
    name: { type: "string" },
    prefix: { type: "string", description: "Masked prefix (nlo_…) — the raw key is never listed" },
    createdAt: { type: "string" },
    lastUsedAt: { type: ["string", "null"] },
    revokedAt: { type: ["string", "null"] },
  },
};

export function registerApiKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get(
    "/api/api-keys",
    {
      schema: {
        summary: "List API keys (metadata only)",
        tags: ["api-keys"],
        security: ADMIN_SECURITY,
        description: "All API keys as metadata; the raw key value is never returned here.",
        response: {
          200: { type: "array", items: apiKeyInfoSchema },
        },
      },
    },
    async () => ctx.apiKeys.list(),
  );

  app.post(
    "/api/api-keys",
    {
      schema: {
        summary: "Create an API key",
        tags: ["api-keys"],
        security: ADMIN_SECURITY,
        description:
          "The raw key (nlo_…) is returned in this response EXACTLY ONCE — store it; " +
          "only the masked prefix is available afterwards.",
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string", minLength: 1, maxLength: 64 } },
        },
        response: {
          201: {
            type: "object",
            required: ["id", "name", "key", "prefix", "createdAt"],
            properties: {
              id: { type: "string" },
              name: { type: "string" },
              key: { type: "string", description: "The raw key — shown only once" },
              prefix: { type: "string" },
              createdAt: { type: "string" },
            },
          },
          400: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const body = createKey.parse(req.body);
      const k = ctx.apiKeys.create(body.name);
      // `key` is the raw key — the ONLY place it is ever returned.
      return reply
        .code(201)
        .send({ id: k.id, name: k.name, key: k.raw, prefix: k.prefix, createdAt: k.createdAt });
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/api-keys/:id/revoke",
    {
      schema: {
        summary: "Revoke an API key",
        tags: ["api-keys"],
        security: ADMIN_SECURITY,
        description: "Idempotent: already-revoked keys return 200; unknown ids return 404.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const wasActive = ctx.apiKeys.revoke(req.params.id);
      if (!wasActive) {
        // Already revoked → idempotent 200; unknown id → 404.
        const known = ctx.apiKeys.list().some((k) => k.id === req.params.id);
        if (!known) throw new ApiError(ApiCodes.notFound, "api key not found", 404);
      }
      return { ok: true };
    },
  );
}
