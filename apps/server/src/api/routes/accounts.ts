import { z } from "zod";
import { existsSync, unlinkSync } from "node:fs";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { PythonWorkerProvider } from "../../providers/python-worker/python-worker-provider.js";

const createAccount = z.object({
  email: z.string().min(3).max(200).email(),
});

const updateAccount = z.object({
  displayEmail: z.string().min(3).max(200).email().optional(),
  status: z
    .enum(["ACTIVE", "DEGRADED", "RATE_LIMITED", "AUTH_REQUIRED", "DISABLED", "UNKNOWN"])
    .optional(),
  enabled: z.boolean().optional(),
  quotaNote: z.string().max(200).nullable().optional(),
});

const ADMIN_SECURITY = [{ adminCookie: [] }];

/** Sanitized account object as returned by every route here. */
const accountSchema = {
  type: "object",
  required: [
    "id",
    "label",
    "displayEmail",
    "status",
    "enabled",
    "hasAuth",
    "createdAt",
    "updatedAt",
    "isDefault",
  ],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    displayEmail: { type: "string" },
    status: {
      type: "string",
      description: "ACTIVE | DEGRADED | RATE_LIMITED | AUTH_REQUIRED | DISABLED | UNKNOWN",
    },
    enabled: { type: "boolean" },
    hasAuth: {
      type: "boolean",
      description: "Whether a credential ref is stored (never the value)",
    },
    lastSuccessAt: { type: ["string", "null"] },
    lastError: { type: ["string", "null"] },
    quotaNote: { type: ["string", "null"] },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    isDefault: { type: "boolean" },
  },
};

export function registerAccountRoutes(app: FastifyInstance, ctx: AppContext): void {
  app.post(
    "/api/accounts",
    {
      schema: {
        summary: "Register a Google account",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description:
          "Registers an account (starts AUTH_REQUIRED — it is unusable until a session is " +
          "imported via the sessions API). No secrets are accepted here.",
        body: {
          type: "object",
          required: ["email"],
          properties: { email: { type: "string", minLength: 3, maxLength: 200 } },
        },
        response: {
          201: accountSchema,
          400: { $ref: "Error" },
          409: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const body = createAccount.parse(req.body);
      let account;
      try {
        account = ctx.accounts.create({
          email: body.email,
          authSecretRef: null, // no secrets via this endpoint
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already exists")) {
          // Do not echo the raw message (nor the email): a clean, generic 409.
          throw new ApiError(ApiCodes.conflict, "email is already registered", 409);
        }
        throw e;
      }
      ctx.accounts.recordError(account.id, "", "AUTH_REQUIRED"); // start unauthed
      // Reset to UNKNOWN-ish: mark as needing auth.
      return reply.code(201).send(sanitizeAccount(account));
    },
  );

  app.get(
    "/api/accounts",
    {
      schema: {
        summary: "List accounts",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description: "All registered Google accounts (secrets never exposed).",
        response: {
          200: { type: "array", items: accountSchema },
        },
      },
    },
    async () => ctx.accounts.list().map(sanitizeAccount),
  );

  app.get<{ Params: { id: string } }>(
    "/api/accounts/:id",
    {
      schema: {
        summary: "Get one account",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description: "One registered Google account (secrets never exposed).",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: { 200: accountSchema, 404: { $ref: "Error" } },
      },
    },
    async (req) => {
      const a = ctx.accounts.get(req.params.id);
      if (!a) throw new ApiError(ApiCodes.notFound, "account not found", 404);
      return sanitizeAccount(a);
    },
  );

  app.patch<{ Params: { id: string } }>(
    "/api/accounts/:id",
    {
      schema: {
        summary: "Update an account",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description: "Partial update — every field is optional.",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            displayEmail: { type: "string", minLength: 3, maxLength: 200 },
            status: {
              type: "string",
              enum: ["ACTIVE", "DEGRADED", "RATE_LIMITED", "AUTH_REQUIRED", "DISABLED", "UNKNOWN"],
            },
            enabled: { type: "boolean" },
            quotaNote: { type: ["string", "null"], maxLength: 200 },
          },
        },
        response: { 200: accountSchema, 404: { $ref: "Error" }, 409: { $ref: "Error" } },
      },
    },
    async (req) => {
      const body = updateAccount.parse(req.body);
      let a;
      try {
        a = ctx.accounts.update(req.params.id, body);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("already exists")) {
          throw new ApiError(ApiCodes.conflict, "email is already registered", 409);
        }
        throw e;
      }
      return sanitizeAccount(a);
    },
  );

  // Set/clear the default account (job-selection preference). At most one
  // account may be default — the repo enforces the invariant atomically.
  const defaultBody = z.object({ isDefault: z.boolean() });

  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/default",
    {
      schema: {
        summary: "Set or clear the default account",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description:
          "Marks the account as the job-selection preference (or clears it). At most one " +
          "account may be default — the repo enforces the invariant atomically.",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: {
          type: "object",
          required: ["isDefault"],
          properties: { isDefault: { type: "boolean" } },
        },
        response: { 200: accountSchema, 404: { $ref: "Error" } },
      },
    },
    async (req) => {
      const body = defaultBody.parse(req.body ?? {});
      const a = ctx.accounts.setDefault(req.params.id, body.isDefault);
      return sanitizeAccount(a);
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/accounts/:id",
    {
      schema: {
        summary: "Delete an account",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description:
          "Removes the account row and its stored session file (best effort). Returns 204.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          204: { description: "No content" },
          404: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
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
    },
  );

  // Safe provider-backed health check (no network in mock).
  app.post<{ Params: { id: string } }>(
    "/api/accounts/:id/health",
    {
      schema: {
        summary: "Probe an account's provider auth status",
        tags: ["accounts"],
        security: ADMIN_SECURITY,
        description:
          "Asks the provider whether the account's session is still valid and persists a " +
          "conservative status change on clear outcomes (no network in mock).",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["account", "ok"],
            properties: {
              account: accountSchema,
              ok: { type: "boolean" },
              email: { type: ["string", "null"] },
              detail: { type: ["string", "null"] },
            },
          },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
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
    },
  );
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
