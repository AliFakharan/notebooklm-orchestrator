import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app-context.js";
import { parseAllowEntry, ApiCodes, ApiError } from "@nlo/shared";

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Liveness (no auth).
  app.get(
    "/api/health",
    {
      schema: {
        summary: "Liveness probe",
        tags: ["health"],
        description: "Always 200 while the process is up. No auth required.",
        response: {
          200: {
            type: "object",
            required: ["ok", "service", "time"],
            properties: {
              ok: { type: "boolean", example: true },
              service: { type: "string", example: "notebooklm-orchestrator" },
              time: { type: "string", description: "ISO-8601 timestamp" },
            },
          },
        },
      },
    },
    async () => ({
      ok: true,
      service: "notebooklm-orchestrator",
      time: new Date().toISOString(),
    }),
  );

  // Readiness: reports provider/proxy runtime state honestly.
  app.get(
    "/api/health/ready",
    {
      schema: {
        summary: "Readiness probe",
        tags: ["health"],
        description:
          "Reports provider configuration and proxy-runtime state honestly. No auth required.",
        response: {
          200: {
            type: "object",
            required: ["ok", "ready", "provider", "proxyRuntime", "liveDisabled"],
            properties: {
              ok: { type: "boolean" },
              ready: { type: "boolean" },
              provider: {
                type: "object",
                required: ["name", "configured"],
                properties: {
                  name: { type: "string" },
                  configured: { type: "boolean" },
                  issues: { type: "array", items: { type: "string" } },
                },
              },
              proxyRuntime: { type: "object", additionalProperties: true },
              liveDisabled: { type: "boolean" },
            },
          },
        },
      },
    },
    async () => {
      const runtime = ctx.runtime.status();
      const providerConfig = await ctx.provider.validateConfiguration().catch(() => ({
        ok: false,
        issues: ["provider validation failed"],
      }));
      return {
        ok: true,
        ready: true,
        provider: {
          name: ctx.provider.name,
          configured: providerConfig.ok,
          issues: providerConfig.issues,
        },
        proxyRuntime: runtime,
        liveDisabled: !ctx.config.liveTestsEnabled,
      };
    },
  );

  // Provider account health probe (safe: no network in mock; gated in live).
  app.post<{ Body: { accountId: string } }>(
    "/api/health/account",
    {
      schema: {
        summary: "Probe a Google account's provider status",
        tags: ["health"],
        description:
          "Asks the provider for the account's auth status (no network in mock; gated in live). No auth required.",
        body: {
          type: "object",
          required: ["accountId"],
          properties: { accountId: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["accountId", "ok"],
            properties: {
              accountId: { type: "string" },
              ok: { type: "boolean" },
              email: { type: ["string", "null"] },
              detail: { type: ["string", "null"] },
            },
          },
          400: { $ref: "Error" },
          404: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const { accountId } = req.body ?? {};
      if (!accountId) {
        return reply.code(400).send({
          error: { code: ApiCodes.validation, message: "accountId required" },
        });
      }
      const account = ctx.accounts.get(accountId);
      if (!account) {
        throw new ApiError(ApiCodes.notFound, "account not found", 404);
      }
      const credentialRef = account.authSecretRef ?? `session:${account.id}`;
      const status = await ctx.provider.getAccountStatus(account.id, credentialRef);
      return { accountId, ...status };
    },
  );

  // SSRF-guarded destination reachability check. The destination is NOT
  // user-supplied here; it is resolved from the server allowlist by name.
  app.post<{ Body: { name: string } }>(
    "/api/health/egress",
    {
      schema: {
        summary: "SSRF-guarded egress reachability check",
        tags: ["health"],
        description:
          "Resolves a destination from the server allowlist by name and reports reachability. The destination is never freely user-supplied. No auth required.",
        body: {
          type: "object",
          required: ["name"],
          properties: { name: { type: "string" } },
        },
        response: {
          200: {
            type: "object",
            required: ["allowed", "performed", "note"],
            properties: {
              allowed: { type: "object", additionalProperties: true },
              performed: { type: "boolean" },
              note: { type: "string" },
            },
          },
          400: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const name = (req.body?.name ?? "").trim();
      const entry = ctx.config.healthAllowlist.find((raw) => {
        try {
          return parseAllowEntry(raw).host.toLowerCase() === name.toLowerCase();
        } catch {
          return false;
        }
      });
      if (!entry) {
        return reply.code(400).send({
          error: {
            code: ApiCodes.ssrfBlocked,
            message: "destination is not in the configured allowlist",
          },
        });
      }
      // In mock mode we do not perform a real outbound check.
      return {
        allowed: entry,
        performed: false,
        note: "real egress check is disabled until the live proxy runtime is approved",
      };
    },
  );
}
