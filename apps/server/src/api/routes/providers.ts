import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app-context.js";

/**
 * Provider information routes.
 *
 * The endpoint reports the provider's identity and its HONEST capability
 * matrix straight from the provider implementation — the server never
 * inflates or re-labels levels. The mock provider is clearly flagged so the
 * UI can label everything it produces as mock.
 */
export function registerProviderRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.get("/api/provider", async () => {
    const config = await ctx.provider.validateConfiguration().catch(() => ({
      ok: false,
      issues: ["provider validation failed"],
    }));
    return {
      name: ctx.provider.name,
      isMock: ctx.provider.name === "mock",
      liveDisabled: !ctx.config.liveTestsEnabled,
      configured: config.ok,
      issues: config.issues,
      capabilities: ctx.provider.capabilities(),
    };
  });
}
