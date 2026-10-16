import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { toApiErrorBody, ApiError, ApiCodes, redactDeep } from "@nlo/shared";
import type { AppContext } from "../app-context.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerProxyRoutes } from "./routes/proxies.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSettingsRoutes } from "./routes/settings.js";

/**
 * Build the Fastify app. Binds to config.host (default 127.0.0.1).
 * Security:
 *  - optional bearer admin token (NLO_ADMIN_TOKEN) on all /api except /api/health
 *  - rate limiting
 *  - consistent error envelope with redaction (never leak secrets/stacks)
 *  - CORS restricted to the Vite dev origin (loopback)
 */
export interface BuildAppOptions {
  /**
   * When the built frontend should be served by this app, name of the
   * index.html inside the static root (registered separately by main). The
   * root not-found handler falls back to it for non-API GET requests.
   */
  spaIndexFile?: string;
}

export async function buildApp(
  ctx: AppContext,
  opts: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const app = Fastify({
    logger: false,
    bodyLimit: ctx.config.maxUploadBytes,
  });

  await app.register(cors, {
    origin: [/^http:\/\/127\.0\.0\.1:\d+$/, /^http:\/\/localhost:\d+$/],
    credentials: true,
  });

  await app.register(rateLimit, {
    global: true,
    max: 300,
    timeWindow: "1 minute",
    allowList: () => false,
    errorResponseBuilder: () => ({
      error: { code: ApiCodes.rateLimited, message: "too many requests" },
    }),
  });

  await app.register(multipart, {
    limits: {
      fileSize: ctx.config.maxUploadBytes,
      fieldSize: 64 * 1024,
      fields: 32,
      files: 4,
    },
  });

  // --- auth (optional) -----------------------------------------------------
  app.addHook("onRequest", async (req, reply) => {
    const token = ctx.config.adminToken;
    if (!token) return; // auth disabled (local single-user, loopback)
    if (req.url.startsWith("/api/health")) return; // readiness is public
    if (!req.url.startsWith("/api")) return; // only the API carries data (SPA static files are public)
    const header = req.headers.authorization;
    if (header === `Bearer ${token}`) return;
    return reply.code(401).send({
      error: { code: ApiCodes.unauthorized, message: "admin token required" },
    });
  });

  // --- consistent error handling ------------------------------------------
  interface FastifyErr extends Error {
    validation?: { message: string }[];
    statusCode?: number;
  }
  app.setErrorHandler((errRaw: unknown, _req, reply) => {
    const err = errRaw as FastifyErr;
    if (errRaw instanceof ApiError) {
      return reply.code(errRaw.httpStatus).send({
        error: {
          code: errRaw.code,
          message: errRaw.message,
          ...(errRaw.details ? { details: redactDeep(errRaw.details) } : {}),
        },
      });
    }
    // Fastify schema validation errors
    if (err.validation) {
      return reply.code(400).send({
        error: {
          code: ApiCodes.validation,
          message: "request validation failed",
          details: redactDeep(err.validation?.map((v) => v.message) ?? []),
        },
      });
    }
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    // Log server-side only (redacted); do NOT echo the raw error to clients.
    console.error(`[nlo:api] ${status}: ${redactDeep(String(err.message ?? err))}`);
    if (status >= 500) {
      return reply.code(500).send({
        error: { code: "internal_error", message: "An unexpected error occurred." },
      });
    }
    return reply.code(status).send(toApiErrorBody(err));
  });

  app.setNotFoundHandler((req, reply) => {
    if (opts.spaIndexFile && req.method === "GET" && !req.url.startsWith("/api")) {
      return reply.type("text/html; charset=utf-8").sendFile(opts.spaIndexFile);
    }
    return reply.code(404).send({ error: { code: ApiCodes.notFound, message: "not found" } });
  });

  registerHealthRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerProxyRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerSettingsRoutes(app, ctx);

  return app;
}
