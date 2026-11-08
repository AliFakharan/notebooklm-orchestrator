import Fastify, { type FastifyInstance } from "fastify";
import cors from "@fastify/cors";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import swagger from "@fastify/swagger";
import swaggerUi from "@fastify/swagger-ui";
import { toApiErrorBody, ApiError, ApiCodes, MAX_SOURCES_PER_JOB, redactDeep } from "@nlo/shared";
import { ZodError } from "zod";
import type { AppContext } from "../app-context.js";
import { guardAdminRoutes, registerAdminRoutes } from "./admin-auth.js";
import { guardJobApiRoutes } from "./api-key-auth.js";
import { registerHealthRoutes } from "./routes/health.js";
import { registerJobRoutes } from "./routes/jobs.js";
import { registerAccountRoutes } from "./routes/accounts.js";
import { registerProxyRoutes } from "./routes/proxies.js";
import { registerProviderRoutes } from "./routes/providers.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerApiKeyRoutes } from "./routes/api-keys.js";

/**
 * Build the Fastify app. Binds to config.host (default 127.0.0.1).
 * Security (local single-user model):
 *  - loopback-only binding by default; there is NO user system and NO
 *    bearer token — the trust boundary is the machine, so never bind to
 *    0.0.0.0 on an exposed interface (main.ts warns when it happens)
 *  - rate limiting
 *  - consistent error envelope with redaction (never leak secrets/stacks)
 *  - CORS restricted to loopback origins
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
      // One part per uploaded source (+ headroom); the route also enforces
      // MAX_SOURCES_PER_JOB with a clear validation error.
      files: MAX_SOURCES_PER_JOB + 4,
    },
  });

  // --- OpenAPI spec + Swagger UI ------------------------------------------
  // Registered BEFORE the route registrations: the spec is built via the
  // onRoute hook, which must exist when each route is added. Routes added
  // afterwards (including swagger-ui's own) are picked up too.
  await app.register(swagger, {
    openapi: {
      info: {
        title: "NotebookLM Orchestrator API",
        version: "0.1.0",
        description:
          "Programmatic access to the job surface (create, list, inspect, cancel, " +
          "requeue, retry) plus admin-gated infrastructure routes (accounts, " +
          "proxies, sessions, providers, api keys). " +
          "Interactive UI: /documentation",
      },
      components: {
        securitySchemes: {
          bearerAuth: {
            type: "http",
            scheme: "bearer",
            bearerFormat: "API key (nlo_\u2026)",
          },
          adminCookie: {
            type: "apiKey",
            in: "header",
            name: "Cookie",
            description: "nlo_admin session cookie (from POST /api/admin/login)",
          },
        },
      },
    },
  });
  await app.register(swaggerUi, { routePrefix: "/documentation" });

  // Shared response schemas, registered via addSchema (NOT in the openapi
  // config above): route-level `response` schemas must resolve `$ref`s at
  // serializer build time (fast-json-stringify only sees addSchema'd schemas
  // as external refs — `#/components/...` refs from the config are
  // invisible to it), while @fastify/swagger renders these under
  // components/schemas in the spec. Must be added before the routes.
  app.addSchema({
    $id: "Error",
    type: "object",
    required: ["error"],
    properties: {
      error: {
        type: "object",
        required: ["code", "message"],
        properties: {
          code: { type: "string", description: "Machine-readable error code" },
          message: { type: "string" },
          details: { description: "Optional validation/failure details (redacted)" },
        },
      },
    },
  });
  app.addSchema({
    $id: "JobSummary",
    type: "object",
    required: ["id", "status", "answerMarkdown", "createdAt"],
    properties: {
      id: { type: "string", example: "j_0123456789abcdef0123456789abcdef" },
      status: {
        type: "string",
        description: "CREATED | RUNNING | SUCCEEDED | FAILED | CANCELLED",
      },
      answerMarkdown: {
        type: ["string", "null"],
        description: "The output — the provider's markdown answer (null until success).",
      },
      createdAt: { type: "string", format: "date-time" },
    },
    // additionalProperties: true matters twice: the spec documents the core
    // fields, and fast-json-stringify (route serializers) passes through the
    // rest of the job object instead of silently dropping it.
    additionalProperties: true,
    description:
      "The full job object also carries input, accountId/nodeId, attempt budget, " +
      "progress, error fields, and provenance.",
  });

  // --- consistent error handling ------------------------------------------
  interface FastifyErr extends Error {
    validation?: { message: string }[];
    statusCode?: number;
  }
  app.setErrorHandler((errRaw: unknown, _req, reply) => {
    const err = errRaw as FastifyErr;
    // Body-payload validation done via zod in the route handlers.
    if (errRaw instanceof ZodError) {
      return reply.code(400).send({
        error: {
          code: ApiCodes.validation,
          message: "request validation failed",
          details: redactDeep(errRaw.issues.map((i) => i.message)),
        },
      });
    }
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
  registerAdminRoutes(app, ctx);
  registerJobRoutes(app, ctx);
  registerAccountRoutes(app, ctx);
  registerProxyRoutes(app, ctx);
  registerProviderRoutes(app, ctx);
  registerSessionRoutes(app, ctx);
  registerApiKeyRoutes(app, ctx);
  // Infrastructure API (accounts/proxies/sessions) requires the admin cookie
  // when credentials are configured. The guard is added last so the admin
  // login routes above are reachable without a cookie.
  guardAdminRoutes(app, ctx);
  // Job surface (/api/jobs*): loopback / trusted IP / admin cookie / API key.
  guardJobApiRoutes(app, ctx);

  return app;
}
