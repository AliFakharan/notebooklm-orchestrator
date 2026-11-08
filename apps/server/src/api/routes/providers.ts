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
  app.get(
    "/api/provider",
    {
      schema: {
        summary: "Provider identity + honest capability matrix",
        tags: ["providers"],
        description:
          "The provider's name and capability levels straight from the implementation — " +
          "never inflated. Not behind the admin cookie gate; the server is loopback-bound " +
          "by default, which is the trust boundary.",
        response: {
          200: {
            type: "object",
            required: ["name", "isMock", "liveDisabled", "configured", "issues", "capabilities"],
            properties: {
              name: { type: "string" },
              isMock: { type: "boolean" },
              liveDisabled: { type: "boolean" },
              configured: { type: "boolean" },
              issues: { type: "array", items: { type: "string" } },
              capabilities: {
                type: "array",
                items: {
                  type: "object",
                  required: ["operation", "level"],
                  properties: {
                    operation: { type: "string" },
                    level: { type: "string" },
                    note: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
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
    },
  );
}
