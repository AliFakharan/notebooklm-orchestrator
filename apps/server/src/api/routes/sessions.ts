import { z } from "zod";
import { chmod, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ApiError, ApiCodes } from "@nlo/shared";
import type { AppContext } from "../../app-context.js";
import { PythonWorkerProvider } from "../../providers/python-worker/python-worker-provider.js";

/**
 * Auth session routes: REAL login/verify/import/logout for the python-worker
 * provider (Playwright interactive sign-in, storage-state import, verification
 * against the real service).
 *
 * Security notes:
 *  - storage-state files live under data/sessions/ with 0600 and are NEVER
 *    served over HTTP (no route returns the file body).
 *  - imports accept base64 or a server-side path and are JSON-validated.
 *  - an import that the service rejects is recorded as SESSION_INVALID —
 *    the session is never "green" on faith in the file alone.
 */

const MAX_IMPORT_BYTES = 2 * 1024 * 1024;
const PROVIDER = "python-worker";

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

  // One auth operation at a time per account: concurrent login/import would
  // race on the same 0600 session file. The state (AUTH_IN_PROGRESS) plus
  // this in-memory set give the UI a reliable "still running" signal.
  const inFlight = new Set<string>();
  const enterAuth = (accountId: string): void => {
    if (inFlight.has(accountId)) {
      throw new ApiError(ApiCodes.conflict, "an authentication operation is already running", 409);
    }
    inFlight.add(accountId);
  };
  const leaveAuth = (accountId: string): void => {
    inFlight.delete(accountId);
  };

  /** Keep the account row in sync after a service-verified session. */
  function syncAccountIdentity(accountId: string, email: string | null): void {
    const acct = ctx.accounts.get(accountId);
    if (!acct || !email) return;
    if (acct.displayEmail !== email) {
      ctx.accounts.update(accountId, { displayEmail: email });
    }
    // A verified login clears a stale AUTH_REQUIRED flag set by an earlier
    // failed job — the fresh service verification is stronger evidence.
    // DISABLED (manual) always wins and is never overridden here.
    if (acct.status === "AUTH_REQUIRED" || acct.status === "UNKNOWN") {
      ctx.accounts.update(accountId, { status: "ACTIVE" });
    }
    ctx.accounts.update(accountId, { lastVerifiedAt: new Date().toISOString() });
  }

  /**
   * Enforce "never associate a session with the wrong account": when the
   * account row carries an expected email and the service-verified identity
   * differs, the session is rejected as SESSION_INVALID with a clear error.
   * Returns the mismatch message, or null when there is no mismatch.
   */
  function mismatchFor(accountId: string, verifiedEmail: string | null): string | null {
    const acct = ctx.accounts.get(accountId);
    if (!acct || !acct.displayEmail || !verifiedEmail) return null;
    if (acct.displayEmail.trim().toLowerCase() === verifiedEmail.trim().toLowerCase()) return null;
    return `identity mismatch: session belongs to ${verifiedEmail}, but this account is for ${acct.displayEmail}`;
  }

  function sessionView(accountId: string) {
    const acct = ctx.accounts.get(accountId);
    const session = ctx.sessions.get(accountId, PROVIDER);
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

  async function verifyAccount(w: PythonWorkerProvider, accountId: string) {
    const acct = ctx.accounts.getOrThrow(accountId);
    ctx.sessions.ensure(accountId, PROVIDER, acct.authProfile ?? "default");
    const status = await w.getAccountStatus(accountId, "session");
    // AUTH_REQUIRED is reachable from every state (it is also a valid
    // self-update), so a single target suffices.
    if (status.ok) {
      const session = ctx.sessions.transition(accountId, PROVIDER, "AUTHENTICATED", {
        email: status.email,
        verified: true,
      });
      syncAccountIdentity(accountId, status.email);
      const mismatch = mismatchFor(accountId, status.email);
      return {
        ok: true as const,
        email: status.email,
        detail: mismatch ? `verified, but: ${mismatch}` : status.detail,
        mismatch: mismatch !== null,
        session,
      };
    }
    const session = ctx.sessions.transition(accountId, PROVIDER, "AUTH_REQUIRED", {
      lastError: status.detail ?? "session rejected by service",
    });
    return {
      ok: false as const,
      email: null as string | null,
      detail: status.detail,
      mismatch: false,
      session,
    };
  }

  app.get("/api/sessions", async () => {
    const accounts = ctx.accounts.list();
    return {
      provider: ctx.provider.name,
      interactiveLogin: worker !== null,
      sessions: accounts.map((a) => sessionView(a.id)),
    };
  });

  app.get<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
    const acct = ctx.accounts.get(req.params.id);
    if (!acct) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    return sessionView(acct.id);
  });

  // --- interactive browser login -------------------------------------------
  const loginBody = z.object({
    timeoutSec: z.number().int().min(60).max(1800).optional(),
    headless: z.boolean().optional(),
    /** Browser channel override: "chromium" (bundled) or "chrome"/"msedge". */
    browser: z.enum(["chromium", "chrome", "msedge"]).optional(),
  });

  // Shared entry check for both live auth paths (login / browser-import).
  const canEnterAuth = (accountId: string): void => {
    ctx.sessions.ensure(
      accountId,
      PROVIDER,
      ctx.accounts.getOrThrow(accountId).authProfile ?? "default",
    );
    const cur = ctx.sessions.get(accountId, PROVIDER)!;
    if (cur.state === "AUTH_IN_PROGRESS") {
      if (inFlight.has(accountId)) {
        throw new ApiError(
          ApiCodes.conflict,
          "authentication is already running for this account",
          409,
        );
      }
      // Stale AUTH_IN_PROGRESS (server restarted mid-login) — recoverable.
    } else if (
      ![
        "AUTH_REQUIRED",
        "CONFIGURED",
        "UNKNOWN",
        "SESSION_EXPIRED",
        "SESSION_INVALID",
        "ACCESS_UNAVAILABLE",
      ].includes(cur.state)
    ) {
      throw new ApiError(ApiCodes.validation, `cannot start auth from state ${cur.state}`, 409);
    }
    enterAuth(accountId);
    ctx.sessions.transition(accountId, PROVIDER, "AUTH_IN_PROGRESS", {});
  };

  app.post<{ Params: { id: string } }>("/api/sessions/:id/login", async (req) => {
    const w = requireWorker();
    const acct = ctx.accounts.get(req.params.id);
    if (!acct) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    const body = loginBody.parse(req.body ?? {});
    canEnterAuth(acct.id);
    try {
      const r = await w.login(acct.id, {
        timeoutSec: body.timeoutSec ?? 600,
        headless: body.headless ?? false,
        browser: body.browser,
      });
      const mismatch = mismatchFor(acct.id, r.email);
      if (mismatch) {
        ctx.sessions.transition(acct.id, PROVIDER, "SESSION_INVALID", { lastError: mismatch });
        throw new ApiError(ApiCodes.conflict, mismatch, 409);
      }
      const s = ctx.sessions.transition(acct.id, PROVIDER, "AUTHENTICATED", {
        email: r.email,
        verified: true,
      });
      syncAccountIdentity(acct.id, r.email);
      return { session: s, email: r.email };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cur = ctx.sessions.get(acct.id, PROVIDER);
      if (cur && cur.state === "AUTH_IN_PROGRESS") {
        ctx.sessions.transition(acct.id, PROVIDER, "AUTH_REQUIRED", {
          lastError: msg.slice(0, 500),
        });
      }
      throw new ApiError(ApiCodes.unauthorized, `login failed: ${msg.slice(0, 300)}`, 401);
    } finally {
      leaveAuth(acct.id);
    }
  });

  // --- import cookies from an installed, non-automated browser --------------
  // Google's bot detection rejects sign-in inside the fresh Playwright
  // browser this app launches ("This browser or app may not be secure").
  // This route is the supported alternative: the user signs in with their
  // normal Chrome/Firefox once, and the app copies that session locally via
  // the installed notebooklm-py CLI, then verifies it against the REAL
  // service. Browser selection is an allowlist — the client never chooses an
  // executable or a path. NOTE: the cookie JAR read itself does not traverse
  // our tunnel (it is a local disk read); the CLI's verification step and all
  // later NotebookLM requests do.
  const BROWSER_COOKIE_OPTIONS: readonly string[] = [
    "auto",
    "chrome",
    "firefox",
    "chromium",
    "brave",
    "edge",
    "opera",
    "vivaldi",
    "librewolf",
    "zen",
    "cachy",
  ];

  const browserImportBody = z.object({
    /** Allowlisted browser name; Chromium profiles via "chrome::Profile 1". */
    browser: z
      .string()
      .min(1)
      .max(80)
      .refine((b) => BROWSER_COOKIE_OPTIONS.includes(b.split("::", 1)[0]!.trim().toLowerCase()), {
        message: "browser is not an allowed cookie source",
      }),
    /** Pick a signed-in Google account by email (multiple accounts). */
    account: z.string().min(3).max(200).optional(),
    timeoutSec: z.number().int().min(30).max(600).optional(),
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/browser-import", async (req) => {
    const w = requireWorker();
    const acct = ctx.accounts.get(req.params.id);
    if (!acct) throw new ApiError(ApiCodes.notFound, "account not found", 404);
    const body = browserImportBody.parse(req.body ?? {});
    canEnterAuth(acct.id);
    try {
      const r = await w.browserImport(acct.id, {
        browser: body.browser,
        account: body.account,
        timeoutSec: body.timeoutSec ?? 180,
      });
      const mismatch = mismatchFor(acct.id, r.email);
      if (mismatch) {
        ctx.sessions.transition(acct.id, PROVIDER, "SESSION_INVALID", { lastError: mismatch });
        throw new ApiError(ApiCodes.conflict, mismatch, 409);
      }
      const s = ctx.sessions.transition(acct.id, PROVIDER, "AUTHENTICATED", {
        email: r.email,
        verified: true,
      });
      syncAccountIdentity(acct.id, r.email);
      return {
        session: s,
        email: r.email,
        routingNote:
          "cookie jar read from your local browser (direct); the session verification and all NotebookLM requests use the configured tunnel",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const cur = ctx.sessions.get(acct.id, PROVIDER);
      if (cur && cur.state === "AUTH_IN_PROGRESS") {
        ctx.sessions.transition(acct.id, PROVIDER, "AUTH_REQUIRED", {
          lastError: msg.slice(0, 500),
        });
      }
      if (err instanceof ApiError && err.httpStatus === 409) throw err;
      throw new ApiError(ApiCodes.unauthorized, `browser import failed: ${msg.slice(0, 300)}`, 401);
    } finally {
      leaveAuth(acct.id);
    }
  });

  // --- verify against the real service --------------------------------------
  const verifyHandler = async (
    req: FastifyRequest<{ Params: { id: string } }>,
    _reply: FastifyReply,
  ) => {
    const w = requireWorker();
    const acct = ctx.accounts.getOrThrow(req.params.id);
    return verifyAccount(w, acct.id);
  };
  app.post<{ Params: { id: string } }>("/api/sessions/:id/verify", verifyHandler);
  // refresh is semantically the same check (the service decides)
  app.post<{ Params: { id: string } }>("/api/sessions/:id/refresh", verifyHandler);

  // --- import a storage-state JSON ------------------------------------------
  const importBody = z.object({
    base64: z.string().min(16).max(MAX_IMPORT_BYTES).optional(),
    serverPath: z.string().min(1).max(1024).optional(),
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/import", async (req) => {
    const w = requireWorker();
    const acct = ctx.accounts.getOrThrow(req.params.id);
    const body = importBody.parse(req.body);
    if (!body.base64 && !body.serverPath) {
      throw new ApiError(ApiCodes.validation, "provide base64 or serverPath", 400);
    }

    // Extract + validate the JSON BEFORE touching the destination.
    let raw: Buffer;
    if (body.base64) {
      raw = Buffer.from(body.base64, "base64");
      if (raw.byteLength > MAX_IMPORT_BYTES) {
        throw new ApiError(ApiCodes.validation, "storage state too large", 400);
      }
    } else {
      const p = path.resolve(body.serverPath!);
      const st = statSync(p);
      if (!st.isFile() || st.size > MAX_IMPORT_BYTES) {
        throw new ApiError(
          ApiCodes.validation,
          "serverPath is not a readable file (or too large)",
          400,
        );
      }
      raw = await readFile(p);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw.toString("utf8"));
    } catch {
      throw new ApiError(ApiCodes.validation, "storage state is not valid JSON", 400);
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as { cookies?: unknown }).cookies)
    ) {
      throw new ApiError(ApiCodes.validation, "storage state must contain a cookies array", 400);
    }

    const dest = w.sessionPathFor(acct.id);
    await mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    await writeFile(dest, raw);
    await chmod(dest, 0o600);

    // The service's verdict decides the state.
    const r = await verifyAccount(w, acct.id);
    if (!r.ok) {
      ctx.sessions.transition(acct.id, PROVIDER, "SESSION_INVALID", {
        lastError: r.detail ?? "imported session rejected by service",
      });
      return { ...r, note: "file stored, but the service rejected it" };
    }
    return r;
  });

  // --- logout ----------------------------------------------------------------
  app.delete<{ Params: { id: string } }>("/api/sessions/:id", async (req) => {
    const w = requireWorker();
    const acct = ctx.accounts.getOrThrow(req.params.id);
    ctx.sessions.delete(acct.id, PROVIDER);
    const f = w.sessionPathFor(acct.id);
    if (existsSync(f)) {
      await unlink(f).catch(() => {});
    }
    return { ok: true };
  });
}
