import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { PythonWorkerProvider } from "../../providers/python-worker/python-worker-provider.js";

const createAccount = z.object({
  label: z.string().min(1).max(80),
  displayEmail: z.string().max(200).optional().default(""),
});

const updateAccount = z.object({
  label: z.string().min(1).max(80).optional(),
  displayEmail: z.string().max(200).optional(),
  status: z
    .enum(["ACTIVE", "DEGRADED", "RATE_LIMITED", "AUTH_REQUIRED", "DISABLED", "UNKNOWN"])
    .optional(),
  enabled: z.boolean().optional(),
  quotaNote: z.string().max(200).nullable().optional(),
});

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post("/api/accounts", async (req, reply) => {
    const body = createAccount.parse(req.body);
    const account = ctx.accounts.create({
      label: body.label,
      displayEmail: body.displayEmail,
      authSecretRef: null, // no secrets via this endpoint
    });
    ctx.accounts.recordError(account.id, "", "AUTH_REQUIRED"); // start unauthed
    // Reset to UNKNOWN-ish: mark as needing auth.
    return reply.code(201).send(sanitizeAccount(account));
  });

  app.get("/api/accounts", async () => ctx.accounts.list().map(sanitizeAccount));

  app.get<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    const a = ctx.accounts.get(req.params.id);
    if (!a) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    return sanitizeAccount(a);
  });

  app.patch<{ Params: { id: string } }>("/api/accounts/:id", async (req) => {
    const body = updateAccount.parse(req.body);
    const a = ctx.accounts.update(req.params.id, body);
    return sanitizeAccount(a);
  });

  // Set/clear the default account (job-selection preference). At most one
  // account may be default — the repo enforces the invariant atomically.
  const defaultBody = z.object({ isDefault: z.boolean() });

  app.post<{ Params: { id: string } }>("/api/accounts/:id/default", async (req) => {
    const body = defaultBody.parse(req.body ?? {});
    const a = ctx.accounts.setDefault(req.params.id, body.isDefault);
    return sanitizeAccount(a);
  });

  app.delete<{ Params: { id: string } }>("/api/accounts/:id", async (req, reply) => {
    const ok = ctx.accounts.delete(req.params.id);
    if (!ok) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    // Account removal must also handle its stored session safely: the
    // auth_sessions row cascades at the DB level, but the 0600
    // storage-state FILE on disk is removed explicitly here.
    const w = ctx.provider instanceof PythonWorkerProvider ? ctx.provider : null;
    if (w) {
      const f = w.sessionPathFor(req.params.id);
      if (existsSync(f)) {
        try {
          unlinkSync(f);
        } catch {
          /* best effort — the account row is already gone */
        }
      }
    }
    return reply.code(204).send();
  });

  // Safe provider-backed health check (no network in mock).
  app.post<{ Params: { id: string } }>("/api/accounts/:id/health", async (req) => {
    const a = ctx.accounts.get(req.params.id);
    if (!a) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    const credentialRef = a.authSecretRef ?? `session:${a.id}`;
    const status = await ctx.provider.getAccountStatus(a.id, credentialRef);
    // Persist a conservative status change only on clear outcomes.
    if (!status.ok && status.detail?.includes("re-auth")) {
      ctx.accounts.recordError(a.id, status.detail, "AUTH_REQUIRED");
    }
    const refreshed = ctx.accounts.get(a.id);
    if (!refreshed) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    return { account: sanitizeAccount(refreshed), ...status };
  });
}

/** Mask any credential reference; never expose the secret ref value. */
function sanitizeAccount(a: {
  id: string;
  label: string;
  displayEmail: string;
  status: string;
  enabled: boolean;
  authSecretRef: string | null;
  lastSuccessAt: string | null;
  lastError: string | null;
  quotaNote: string | null;
  createdAt: string;
  updatedAt: string;
  isDefault?: boolean;
}) {
  const row = a as unknown as Record<string, unknown>;
  return {
    id: row.id,
    label: row.label,
    displayEmail: row.displayEmail,
    status: row.status,
    enabled: row.enabled,
    hasAuth: Boolean(row.authSecretRef),
    lastSuccessAt: row.lastSuccessAt,
    lastError: row.lastError,
    quotaNote: row.quotaNote,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isDefault: Boolean(row.isDefault),
  };
}
