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
      return { ok: true as const, email: status.email, detail: status.detail, session };
    }
    const session = ctx.sessions.transition(accountId, PROVIDER, "AUTH_REQUIRED", {
      lastError: status.detail ?? "session rejected by service",
    });
    return {
      ok: false as const,
      email: null as string | null,
      detail: status.detail,
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
  });

  app.post<{ Params: { id: string } }>("/api/sessions/:id/login", async (req) => {
    const w = requireWorker();
    const acct = ctx.accounts.getOrThrow(req.params.id);
    const body = loginBody.parse(req.body ?? {});
    ctx.sessions.ensure(acct.id, PROVIDER, acct.authProfile ?? "default");
    const cur = ctx.sessions.get(acct.id, PROVIDER)!;
    const canEnter = [
      "AUTH_REQUIRED",
      "CONFIGURED",
      "UNKNOWN",
      "SESSION_EXPIRED",
      "SESSION_INVALID",
      "ACCESS_UNAVAILABLE",
    ].includes(cur.state);
    if (!canEnter) {
      throw new ApiError(ApiCodes.validation, `cannot start login from state ${cur.state}`, 409);
    }
    ctx.sessions.transition(acct.id, PROVIDER, "AUTH_IN_PROGRESS", {});
    try {
      const r = await w.login(acct.id, {
        timeoutSec: body.timeoutSec ?? 600,
        headless: body.headless ?? false,
      });
      const s = ctx.sessions.transition(acct.id, PROVIDER, "AUTHENTICATED", {
        email: r.email,
        verified: true,
      });
      return { session: s, email: r.email };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      ctx.sessions.transition(acct.id, PROVIDER, "AUTH_REQUIRED", {
        lastError: msg.slice(0, 500),
      });
      throw new ApiError(ApiCodes.unauthorized, `login failed: ${msg.slice(0, 300)}`, 401);
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
