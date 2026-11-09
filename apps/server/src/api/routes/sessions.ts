import { z } from "zod";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { PythonWorkerProvider } from "../../providers/python-worker/python-worker-provider.js";
import {
  CookieImportError,
  parsePastedCookies,
  toStorageState,
} from "../../domain/cookie-import.js";
import { VERIFY_PROVIDER, verifySession } from "../../auth/verify-service.js";

/**
 * Auth session routes: REAL cookie-paste import / verify / logout for the
 * python-worker provider.
 *
 * The ONLY way to authenticate an account is to paste session cookies that
 * the user copied from their own (non-automated) browser after signing into
 * notebooklm.google.com there. This app never launches a browser and never
 * reads a browser's cookie jar.
 *
 * Security notes:
 *  - storage-state files live under data/sessions/ with 0600 and are NEVER
 *    served over HTTP (no route returns the file body).
 *  - pasted cookie input is parsed (storage state / JSON array / Netscape
 *    cookies.txt), filtered to google.com cookies, and re-serialized into a
 *    strict Playwright storage state before it is written.
 *  - an import that the service rejects is recorded as SESSION_INVALID —
 *    the session is never "green" on faith in the file alone.
 */

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;

const ADMIN_SECURITY = [{ adminCookie: [] }];

const sessionAccountSchema = {
  type: ["object", "null"],
  properties: {
    id: { type: "string" },
    label: { type: "string" },
    enabled: { type: "boolean" },
    displayEmail: { type: "string" },
    authSecretRef: {
      type: ["string", "null"],
      description: "Literal 'present' or null — never the secret value",
    },
    authProfile: { type: ["string", "null"] },
  },
};

const sessionViewSchema = {
  type: "object",
  required: ["accountId", "account", "session", "sessionUsable", "hasStoredFile"],
  properties: {
    accountId: { type: "string" },
    account: sessionAccountSchema,
    session: {
      type: ["object", "null"],
      additionalProperties: true,
      description: "Session state row (state, email, lastError, …) or null",
    },
    sessionUsable: { type: "boolean" },
    hasStoredFile: { type: "boolean" },
  },
};

const verifyResultSchema = {
  type: "object",
  required: ["ok", "email", "detail", "mismatch", "session"],
  properties: {
    ok: { type: "boolean" },
    email: { type: ["string", "null"] },
    detail: { type: ["string", "null"] },
    mismatch: { type: "boolean" },
    session: { type: "object", additionalProperties: true },
  },
};

const importResultSchema = {
  type: "object",
  additionalProperties: true,
  properties: {
    ok: { type: "boolean" },
    email: { type: ["string", "null"] },
    detail: { type: ["string", "null"] },
    mismatch: { type: "boolean" },
    session: { type: "object", additionalProperties: true },
    note: { type: "string" },
  },
};

const sessionVerifyOptions = {
  schema: {
    summary: "Verify the account's session against the real service",
    tags: ["sessions"],
    security: ADMIN_SECURITY,
    description:
      "Runs a live, tunnel-routed service check of the stored session. On success the account " +
      "becomes AUTHENTICATED; on rejection AUTH_REQUIRED. Requires NLO_PROVIDER=python-worker.",
    params: { type: "object", properties: { id: { type: "string" } } },
    response: {
      200: verifyResultSchema,
      400: { $ref: "Error" },
      404: { $ref: "Error" },
      409: { $ref: "Error" },
    },
  },
};

export function registerSessionRoutes(app: FastifyInstance, ctx: AppContext): void {
  const worker: PythonWorkerProvider | null =
    ctx.provider instanceof PythonWorkerProvider ? ctx.provider : null;

  const requireWorker = (): PythonWorkerProvider => {
    if (!worker) {
      throw new ApiError(
        ApiCodes.validation,
        "auth sessions require NLO_PROVIDER=python-worker (the mock provider has no real login)",
        400,
      );
    }
    return worker;
  };

  // One auth operation at a time per account is enforced by ctx.authGuard
  // (shared with the background session keeper): concurrent login/import/
  // verify would race on the same 0600 session file.

  function sessionView(accountId: string) {
    const acct = ctx.accounts.get(accountId);
    const session = ctx.sessions.get(accountId, VERIFY_PROVIDER);
    return {
      accountId,
      account: acct
        ? {
            id: acct.id,
            label: acct.label,
            enabled: acct.enabled,
            displayEmail: acct.displayEmail,
            authSecretRef: acct.authSecretRef ? "present" : null,
            authProfile: acct.authProfile,
          }
        : null,
      session: session ?? null,
      sessionUsable: ctx.sessions.isUsable(session),
      hasStoredFile: worker !== null && existsSync(worker.sessionPathFor(accountId)),
    };
  }

  app.get(
    "/api/sessions",
    {
      schema: {
        summary: "List auth sessions (one per account)",
        tags: ["sessions"],
        security: ADMIN_SECURITY,
        description:
          "One session view per account. This app never launches a browser: accounts " +
          "authenticate by pasting cookies copied from the user's own browser (see /import).",
        response: {
          200: {
            type: "object",
            required: ["provider", "interactiveLogin", "sessions"],
            properties: {
              provider: { type: "string" },
              interactiveLogin: { type: "boolean", example: false },
              sessions: { type: "array", items: sessionViewSchema },
            },
          },
        },
      },
    },
    async () => {
      const accounts = ctx.accounts.list();
      return {
        provider: ctx.provider.name,
        // This app never launches a browser: accounts authenticate by pasting
        // cookies copied from the user's own browser (see /import).
        interactiveLogin: false,
        sessions: accounts.map((a) => sessionView(a.id)),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/sessions/:id",
    {
      schema: {
        summary: "Get one account's auth session",
        tags: ["sessions"],
        security: ADMIN_SECURITY,
        description: "The auth session view for a single account.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: { 200: sessionViewSchema, 404: { $ref: "Error" } },
      },
    },
    async (req) => {
      const acct = ctx.accounts.get(req.params.id);
      if (!acct) throw new ApiError(ApiCodes.notFound, "account not found", 404);
      return sessionView(acct.id);
    },
  );

  // --- paste-import (the only auth path) ------------------------------------
  // Re-import must be possible from ANY state (including AUTHENTICATED): the
  // user's browser session expires server-side and refreshing the pasted
  // cookies is how they recover. Only a concurrent op (or a manually
  // DISABLED session) blocks it.
  const canEnterAuth = (accountId: string): void => {
    ctx.sessions.ensure(
      accountId,
      VERIFY_PROVIDER,
      ctx.accounts.getOrThrow(accountId).authProfile ?? "default",
    );
    const cur = ctx.sessions.get(accountId, VERIFY_PROVIDER)!;
    if (cur.state === "AUTH_IN_PROGRESS") {
      if (ctx.authGuard.running(accountId)) {
        throw new ApiError(
          ApiCodes.conflict,
          "authentication is already running for this account",
          409,
        );
      }
      // Stale AUTH_IN_PROGRESS (server restarted mid-op) — recoverable.
    } else if (cur.state === "DISABLED") {
      throw new ApiError(ApiCodes.validation, `cannot start auth from state ${cur.state}`, 409);
    }
    ctx.authGuard.enter(accountId);
    ctx.sessions.transition(accountId, VERIFY_PROVIDER, "AUTH_IN_PROGRESS", {});
  };

  /** Record a failed auth op back onto the session row (defensive: never
   *  throws — a state bookkeeping issue must not mask the original error). */
  const recordAuthFailure = (accountId: string, lastError: string): void => {
    try {
      const cur = ctx.sessions.get(accountId, VERIFY_PROVIDER);
      if (cur && cur.state !== "AUTH_REQUIRED") {
        ctx.sessions.transition(accountId, VERIFY_PROVIDER, "AUTH_REQUIRED", { lastError });
      }
    } catch {
      /* bookkeeping only */
    }
  };

  // --- verify against the real service --------------------------------------
  // Shares ctx.authGuard with the background keeper and the import path so a
  // verify never races a concurrent import/keeper poke on the same file.
  const verifyHandler = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    _reply: FastifyReply,
  ) => {
    requireWorker();
    const acct = ctx.accounts.getOrThrow(req.params.id);
    // enter() throws a clean 409 on a true conflict (keeper/import in flight).
    ctx.authGuard.enter(acct.id);
    try {
      return await verifySession(ctx, acct.id);
    } catch (e) {
      // A hard provider error during a live check (worker down, package
      // hard-fail) is a client-visible check failure, not a 500.
      const msg = e instanceof Error ? e.message : String(e);
      recordAuthFailure(acct.id, msg);
      throw new ApiError(ApiCodes.conflict, `verification failed: ${msg}`, 409);
    } finally {
      ctx.authGuard.leave(acct.id);
    }
  };
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/verify",
    sessionVerifyOptions,
    verifyHandler,
  );
  // refresh is semantically the same check (the service decides)
  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/refresh",
    sessionVerifyOptions,
    verifyHandler,
  );

  // --- import: paste cookies from your own browser (the only auth path) -------
  // Accepted input (auto-detected, in order):
  //   1. Playwright storage state  {"cookies":[...], "origins":[...]}
  //   2. a JSON cookie array       [{"domain":".google.com", ...}, ...]
  //   3. a Netscape cookies.txt    "#HttpOnly_.google.com\tTRUE\t/\tTRUE\t...\tNAME\tVAL"
  // Input arrives as `cookies` (raw text) or `base64` (base64 of that text) —
  // the UI sends plain text as base64 so arbitrary cookie bytes survive JSON
  // transport. The parsed document is FILTERED to google.com cookies, written
  // 0600, and verified against the REAL service (tunnel-routed) before the
  // account may be used. Re-import from any state is allowed (renewing an
  // expired session is the main reason to import again).
  const importBody = z
    .object({
      cookies: z.string().min(1).max(MAX_IMPORT_BYTES).optional(),
      base64: z
        .string()
        .min(16)
        .max(MAX_IMPORT_BYTES * 4)
        .optional(),
      serverPath: z.string().min(1).max(1024).optional(),
    })
    .refine(
      (b) => Boolean(b.cookies) || Boolean(b.base64) || Boolean(b.serverPath),
      "provide cookies, base64, or serverPath",
    );

  app.post<{ Params: { id: string } }>(
    "/api/sessions/:id/import",
    {
      schema: {
        summary: "Import session cookies (the only auth path)",
        tags: ["sessions"],
        security: ADMIN_SECURITY,
        description:
          "Paste cookies copied from your own browser after signing into notebooklm. " +
          "Auto-detects Playwright storage state, a JSON cookie array, or Netscape cookies.txt; " +
          "filters to google.com cookies, writes them 0600, and verifies against the REAL " +
          "service before the account may be used. Provide one of cookies, base64, or serverPath.",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: {
          type: "object",
          description: "Provide one of cookies, base64, or serverPath.",
          properties: {
            cookies: {
              type: "string",
              description: "Raw cookie text (storage state / JSON array / Netscape cookies.txt)",
            },
            base64: { type: "string", description: "base64 of the raw cookie text" },
            serverPath: {
              type: "string",
              description: "Path on the server (operator convenience)",
            },
          },
        },
        response: {
          200: importResultSchema,
          400: { $ref: "Error" },
          404: { $ref: "Error" },
          409: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const w = requireWorker();
      const acct = ctx.accounts.getOrThrow(req.params.id);
      const body = importBody.parse(req.body);

      // --- extract the raw text ------------------------------------------------
      let text: string;
      if (body.cookies !== undefined) {
        text = body.cookies;
      } else if (body.base64 !== undefined) {
        const raw = Buffer.from(body.base64, "base64");
        if (raw.byteLength > MAX_IMPORT_BYTES) {
          throw new ApiError(ApiCodes.validation, "cookie input too large (max 2 MiB)", 400);
        }
        text = raw.toString("utf8");
      } else {
        // serverPath: operator-only convenience (file on THIS machine, size-checked).
        const p = path.resolve(body.serverPath!);
        const st = statSync(p);
        if (!st.isFile() || st.size > MAX_IMPORT_BYTES) {
          throw new ApiError(
            ApiCodes.validation,
            "serverPath is not a readable file (or too large)",
            400,
          );
        }
        text = (await readFile(p)).toString("utf8");
      }

      // --- parse + filter BEFORE touching the destination ----------------------
      let parsed;
      try {
        parsed = parsePastedCookies(text);
      } catch (e) {
        const msg = e instanceof CookieImportError ? e.message : "unrecognized cookie format";
        throw new ApiError(ApiCodes.validation, msg, 400);
      }
      const stateJson = toStorageState(parsed);

      const dest = w.sessionPathFor(acct.id);
      await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
      await writeFile(dest, stateJson);
      await chmod(dest, 0o600);

      // --- the service's verdict decides the state ------------------------------
      // verifySession performs its own transitions from AUTH_IN_PROGRESS:
      //  success  -> AUTHENTICATED (+ account identity sync)
      //  rejected -> AUTH_REQUIRED (session.lastError carries the reason)
      canEnterAuth(acct.id);
      try {
        let r: Awaited<ReturnType<typeof verifySession>>;
        try {
          r = await verifySession(ctx, acct.id);
        } catch (e) {
          // The provider surfaced a HARD error while the service checked the
          // imported session (e.g. notebooklm-py rejected the cookie set:
          // "missing required cookies"). That is a rejected import, not a
          // server fault: keep the stored file, return to AUTH_REQUIRED with
          // the reason, and report a clean 409 (never a 500).
          const msg = e instanceof Error ? e.message : String(e);
          recordAuthFailure(acct.id, msg);
          throw new ApiError(ApiCodes.conflict, `imported session rejected: ${msg}`, 409);
        }
        if (!r.ok) {
          return { ...r, note: "file stored, but the service rejected it" };
        }
        if (r.mismatch) {
          // Verified, but the identity is someone else: never green.
          ctx.sessions.transition(acct.id, VERIFY_PROVIDER, "SESSION_INVALID", {
            lastError: r.detail ?? "identity mismatch",
          });
          throw new ApiError(ApiCodes.conflict, r.detail ?? "identity mismatch", 409);
        }
        return r;
      } finally {
        ctx.authGuard.leave(acct.id);
      }
    },
  );

  // --- logout ----------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/api/sessions/:id",
    {
      schema: {
        summary: "Log out / delete an account's stored session",
        tags: ["sessions"],
        security: ADMIN_SECURITY,
        description: "Removes the session row and the 0600 storage-state file.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["ok"],
            properties: { ok: { type: "boolean" } },
          },
          400: { $ref: "Error" },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const w = requireWorker();
      const acct = ctx.accounts.getOrThrow(req.params.id);
      ctx.sessions.delete(acct.id, VERIFY_PROVIDER);
      const f = w.sessionPathFor(acct.id);
      if (existsSync(f)) {
        await unlink(f).catch(() => {});
      }
      return { ok: true };
    },
  );
}
