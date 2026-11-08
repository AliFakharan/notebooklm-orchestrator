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

export function registerApiKeyRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/api-keys", async () => ctx.apiKeys.list());

  app.post("/api/api-keys", async (req, reply) => {
    const body = createKey.parse(req.body);
    const k = ctx.apiKeys.create(body.name);
    // `key` is the raw key — the ONLY place it is ever returned.
    return reply
      .code(201)
      .send({ id: k.id, name: k.name, key: k.raw, prefix: k.prefix, createdAt: k.createdAt });
  });

  app.post<{ Params: { id: string } }>("/api/api-keys/:id/revoke", async (req) => {
    const wasActive = ctx.apiKeys.revoke(req.params.id);
    if (!wasActive) {
      // Already revoked → idempotent 200; unknown id → 404.
      const known = ctx.apiKeys.list().some((k) => k.id === req.params.id);
      if (!known) throw new ApiError(ApiCodes.notFound, "api key not found", 404);
    }
    return { ok: true };
  });
}
