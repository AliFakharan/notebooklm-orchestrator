import type { FastifyInstance } from "fastify";
import type { AppContext } from "../../app-context.js";
import { parseAllowEntry, ApiCodes, ApiError } from "@nlo/shared";

export function registerHealthRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Liveness (no auth).
  app.get("/api/health", async () => ({
    ok: true,
    service: "notebooklm-orchestrator",
    time: new Date().toISOString(),
  }));

  // Readiness: reports provider/proxy runtime state honestly.
  app.get("/api/health/ready", async () => {
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
  });

  // Provider account health probe (safe: no network in mock; gated in live).
  app.post<{ Body: { accountId: string } }>("/api/health/account", async (req, reply) => {
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
    const credentialRef = account.authSecretRef ?? `mock-cred:${account.id}`;
    const status = await ctx.provider.getAccountStatus(account.id, credentialRef);
    return { accountId, ...status };
  });

  // SSRF-guarded destination reachability check. The destination is NOT
  // user-supplied here; it is resolved from the server allowlist by name.
  app.post<{ Body: { name: string } }>("/api/health/egress", async (req, reply) => {
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
  });
}
