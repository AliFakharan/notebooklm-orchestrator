import { z } from "zod";
import type { FastifyInstance } from "fastify";
import {
  ApiError,
  ApiCodes,
  parseVlessUri,
  parseVlessUriList,
  maskUuid,
  type ProxyNodeConfig,
} from "@nlo/shared";
import type { AppContext } from "../../app-context.js";

const manualNode = z.object({
  name: z.string().min(1).max(120),
  server: z.string().min(1).max(255),
  port: z.number().int().min(1).max(65535),
  uuid: z
    .string()
    .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "invalid UUID"),
  transport: z.enum(["tcp", "ws", "grpc"]).default("tcp"),
  security: z.enum(["none", "tls", "reality"]).default("none"),
  sni: z.string().max(255).optional(),
  wsHost: z.string().max(255).optional(),
  wsPath: z.string().max(512).optional(),
  pbk: z.string().max(255).optional(),
  sid: z.string().max(64).optional(),
  spx: z.string().max(128).optional(),
  flow: z.string().max(64).optional(),
  encryption: z.string().max(32).optional(),
  alpn: z.string().max(64).optional(),
  extra: z.record(z.string()).optional(),
  priority: z.number().int().min(0).max(10000).optional(),
});

const ADMIN_SECURITY = [{ adminCookie: [] }];

/** A masked node — the UUID shown masked; never the secret value. */
const maskedNodeSchema = {
  type: "object",
  required: ["id", "enabled", "priority", "preferred", "createdAt", "updatedAt", "config"],
  properties: {
    id: { type: "string" },
    enabled: { type: "boolean" },
    priority: { type: "integer" },
    preferred: { type: "boolean" },
    createdAt: { type: "string" },
    updatedAt: { type: "string" },
    config: {
      type: "object",
      additionalProperties: true,
      properties: {
        uuidMasked: { type: "string", description: "Masked UUID — never the secret" },
        name: { type: "string" },
        server: { type: "string" },
        port: { type: "integer" },
        transport: { type: "string" },
        security: { type: "string" },
      },
    },
  },
};

/** A persisted per-node health row, or null when no check has run yet. */
const healthRowSchema = {
  type: ["object", "null"],
  additionalProperties: true,
  properties: {
    nodeId: { type: "string" },
    lastCheckedAt: { type: ["string", "null"] },
    ok: { type: "boolean" },
    egressIp: { type: ["string", "null"] },
    latencyMs: { type: ["number", "null"] },
    error: { type: ["string", "null"] },
    startedAt: { type: ["string", "null"] },
    target: { type: ["string", "null"] },
  },
};

/** A list row: the masked node's fields flat, plus its last health row. */
const proxyListRowSchema = {
  type: "object",
  required: [...maskedNodeSchema.required, "health"],
  properties: {
    ...maskedNodeSchema.properties,
    health: healthRowSchema,
  },
};

export function registerProxyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Add by URI (recommended): secret (UUID) goes straight to the vault.
  app.post(
    "/api/proxies",
    {
      schema: {
        summary: "Add a proxy node from a vless:// URI",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Parses a vless:// share URI and creates the node; the UUID secret goes " +
          "straight to the vault, the DB keeps only a reference. Returns the masked " +
          "node plus any parse warnings.",
        body: {
          type: "object",
          required: ["uri"],
          properties: {
            uri: { type: "string", maxLength: 2048 },
            priority: { type: "integer" },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["node", "warnings"],
            properties: {
              node: maskedNodeSchema,
              warnings: { type: "array", items: { type: "string" } },
            },
          },
          400: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const body = z
        .object({ uri: z.string().max(2048), priority: z.number().int().optional() })
        .parse(req.body);
      let parsed;
      try {
        parsed = parseVlessUri(body.uri);
      } catch (err) {
        throw new ApiError(ApiCodes.validation, (err as Error).message, 400);
      }
      // Store the UUID in the vault; DB keeps only the reference.
      const uuid = parsed.config.uuidSecretRef.replace(/^vless-uuid:/, "");
      ctx.vault.put(parsed.config.uuidSecretRef, uuid, "vless-uuid");

      const node = ctx.proxies.create(parsed.config, { priority: body.priority });
      return reply.code(201).send({ node: maskNode(node), warnings: parsed.warnings });
    },
  );

  // Batch import from a clipboard blob: MULTIPLE vless:// URIs (one per
  // line or whitespace-separated), the common provider share format.
  // Each line is validated independently and reported back (never "throw
  // on the first bad line"); duplicates are detected both within the blob
  // and against existing nodes (by connection identity, not by the
  // cosmetic display name).
  app.post(
    "/api/proxies/import",
    {
      schema: {
        summary: "Batch-import nodes from pasted vless:// URIs",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Accepts a blob with MULTIPLE vless:// URIs (one per line or whitespace-" +
          "separated), the common provider share format. Each line is validated " +
          "independently and reported back; duplicates are detected within the blob " +
          "and against existing nodes by connection identity, not display name.",
        body: {
          type: "object",
          required: ["text"],
          properties: {
            text: { type: "string", minLength: 1, maxLength: 1000000 },
            priority: { type: "integer", minimum: 0, maximum: 10000 },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["total", "added", "skipped", "errors", "results"],
            properties: {
              total: { type: "integer" },
              added: { type: "integer" },
              skipped: { type: "integer" },
              errors: { type: "integer" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  additionalProperties: true,
                  required: ["line", "status"],
                  properties: {
                    line: { type: "integer" },
                    server: { type: ["string", "null"] },
                    port: { type: ["number", "null"] },
                    status: { type: "string" },
                    node: maskedNodeSchema,
                    reason: { type: "string" },
                    warnings: { type: "array", items: { type: "string" } },
                  },
                },
              },
            },
          },
          400: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const body = z
        .object({
          text: z.string().min(1).max(1_000_000),
          priority: z.number().int().min(0).max(10000).optional(),
        })
        .parse(req.body);

      const lines = parseVlessUriList(body.text);
      if (lines.length === 0) {
        throw new ApiError(ApiCodes.validation, "no vless:// URIs found in the pasted text", 400);
      }

      const existing = new Map(ctx.proxies.list().map((n) => [identityKey(n.config), n.id]));
      const seenInBlob = new Set<string>();
      const results: {
        line: number;
        server: string | null;
        port: number | null;
        status: "added" | "skipped" | "error";
        node?: ReturnType<typeof maskNode>;
        reason?: string;
        warnings?: string[];
      }[] = [];
      let added = 0;
      let skipped = 0;
      let errors = 0;

      for (const l of lines) {
        if (!l.config) {
          errors += 1;
          results.push({
            line: l.line,
            server: null,
            port: null,
            status: "error",
            reason: l.error,
          });
          continue;
        }
        const c = l.config;
        const key = identityKey(c);
        if (existing.has(key)) {
          skipped += 1;
          results.push({
            line: l.line,
            server: c.server,
            port: c.port,
            status: "skipped",
            reason: "already exists",
          });
          continue;
        }
        if (seenInBlob.has(key)) {
          skipped += 1;
          results.push({
            line: l.line,
            server: c.server,
            port: c.port,
            status: "skipped",
            reason: "duplicate within pasted list",
          });
          continue;
        }
        try {
          ctx.vault.put(c.uuidSecretRef, c.uuidSecretRef.replace(/^vless-uuid:/, ""), "vless-uuid");
          const node = ctx.proxies.create(c, { priority: body.priority });
          seenInBlob.add(key);
          existing.set(key, node.id);
          added += 1;
          results.push({
            line: l.line,
            server: c.server,
            port: c.port,
            status: "added",
            node: maskNode(node),
            warnings: l.warnings,
          });
        } catch (err) {
          errors += 1;
          results.push({
            line: l.line,
            server: c.server,
            port: c.port,
            status: "error",
            reason: err instanceof Error ? err.message : "create failed",
          });
        }
      }

      return reply.code(200).send({
        total: lines.length,
        added,
        skipped,
        errors,
        results,
      });
    },
  );

  // Add manually (all fields provided; UUID still vaulted).
  app.post(
    "/api/proxies/manual",
    {
      schema: {
        summary: "Add a proxy node manually (all fields)",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Create a node from individual fields instead of a vless:// URI. The UUID " +
          "is still vaulted; only the masked form is ever returned.",
        body: {
          type: "object",
          required: ["name", "server", "port", "uuid"],
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            server: { type: "string", minLength: 1, maxLength: 255 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            uuid: {
              type: "string",
              pattern:
                "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
            },
            transport: { type: "string" },
            security: { type: "string" },
            sni: { type: "string", maxLength: 255 },
            wsHost: { type: "string", maxLength: 255 },
            wsPath: { type: "string", maxLength: 512 },
            pbk: { type: "string", maxLength: 255 },
            sid: { type: "string", maxLength: 64 },
            spx: { type: "string", maxLength: 128 },
            flow: { type: "string", maxLength: 64 },
            encryption: { type: "string", maxLength: 32 },
            alpn: { type: "string", maxLength: 64 },
            extra: { type: "object", additionalProperties: { type: "string" } },
            priority: { type: "integer", minimum: 0, maximum: 10000 },
          },
        },
        response: {
          201: {
            type: "object",
            required: ["node"],
            properties: { node: maskedNodeSchema },
          },
          400: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const body = manualNode.parse(req.body);
      const ref = `vless-uuid:${body.uuid}`;
      ctx.vault.put(ref, body.uuid, "vless-uuid");
      const config: ProxyNodeConfig = {
        name: body.name,
        server: body.server,
        port: body.port,
        uuidSecretRef: ref,
        transport: body.transport,
        security: body.security,
        sni: body.sni,
        wsHost: body.wsHost,
        wsPath: body.wsPath,
        pbk: body.pbk,
        sid: body.sid,
        spx: body.spx,
        flow: body.flow,
        encryption: body.encryption,
        alpn: body.alpn,
        extra: body.extra ?? {},
      };
      const node = ctx.proxies.create(config, { priority: body.priority });
      return reply.code(201).send({ node: maskNode(node) });
    },
  );

  // List with the persisted per-node health (last check), so the UI can
  // show a latency column without running fresh checks on load.
  app.get(
    "/api/proxies",
    {
      schema: {
        summary: "List proxy nodes with their last health row",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "All nodes as masked views, each carrying its persisted per-node health " +
          "row (the last check) so the UI can show latency without running fresh " +
          "checks on load.",
        response: {
          200: { type: "array", items: proxyListRowSchema },
        },
      },
    },
    async () =>
      ctx.proxies.list().map((n) => ({ ...maskNode(n), health: ctx.proxies.health(n.id) })),
  );

  // Ping ALL nodes with a bounded concurrency. Each check is the same
  // staged, SSRF-guarded health check as the single-node endpoint and
  // persists its own health row, so a subsequent list call reflects the
  // fresh latencies. Destination: notebooklm.google.com:443 when it is
  // allowlisted (the default), otherwise the first allowlist entry — the
  // SSRF guard only permits allowlisted targets, and tests use a fixed-IP
  // allowlist that deliberately excludes the real host.
  app.post(
    "/api/proxies/ping-all",
    {
      schema: {
        summary: "Health-check every node (bounded concurrency)",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Runs the staged, SSRF-guarded health check on every node with bounded " +
          "concurrency. Each check persists its own health row, so a subsequent " +
          "list reflects the fresh latencies. Destination: notebooklm.google.com:443 " +
          "when it is allowlisted, otherwise the first allowlist entry.",
        response: {
          200: {
            type: "object",
            required: ["at", "target", "results"],
            properties: {
              at: { type: "string" },
              target: { type: "string" },
              results: {
                type: "array",
                items: {
                  type: "object",
                  required: ["id", "ok", "latencyMs", "error", "lastCheckedAt"],
                  properties: {
                    id: { type: "string" },
                    ok: { type: "boolean" },
                    latencyMs: { type: ["number", "null"] },
                    error: { type: ["string", "null"] },
                    lastCheckedAt: { type: "string" },
                  },
                },
              },
            },
          },
        },
      },
    },
    async () => {
      const nblHost = "notebooklm.google.com";
      const nblAllowed = ctx.config.healthAllowlist.some(
        (e) => (e.includes(":") ? (e.split(":")[0] ?? "") : e).replace(/^\[|\]$/g, "") === nblHost,
      );
      const dest = nblAllowed ? { host: nblHost, port: 443 } : destFromAllowlist(ctx);
      const nodes = ctx.proxies.list();
      const results = await mapLimit(nodes, 6, async (n) => {
        const at = new Date().toISOString();
        try {
          const res = await ctx.proxyManager.runHealthCheck(n.id, dest);
          return {
            id: n.id,
            ok: res.ok,
            latencyMs: res.latencyMs,
            error: res.error,
            lastCheckedAt: at,
          };
        } catch (e) {
          return {
            id: n.id,
            ok: false,
            latencyMs: null,
            error: (e as Error).message,
            lastCheckedAt: at,
          };
        }
      });
      return { at: new Date().toISOString(), target: `${dest.host}:${dest.port}`, results };
    },
  );

  app.get<{ Params: { id: string } }>(
    "/api/proxies/:id",
    {
      schema: {
        summary: "Get one proxy node with its health history",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description: "The masked node, its last health row, and recent health-history rows.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["node", "health", "history"],
            properties: {
              node: maskedNodeSchema,
              health: healthRowSchema,
              history: { type: "array", items: { type: "object", additionalProperties: true } },
            },
          },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const n = ctx.proxies.get(req.params.id);
      if (!n) throw new ApiError(ApiCodes.notFound, "node not found", 404);
      return {
        node: maskNode(n),
        health: ctx.proxies.health(n.id),
        history: ctx.proxies.history(n.id),
      };
    },
  );

  const patchNode = z.object({
    name: z.string().min(1).max(120).optional(),
    server: z.string().min(1).max(255).optional(),
    port: z.number().int().min(1).max(65535).optional(),
    transport: z.enum(["tcp", "ws", "grpc"]).optional(),
    security: z.enum(["none", "tls", "reality"]).optional(),
    sni: z.string().max(255).nullable().optional(),
    wsHost: z.string().max(255).nullable().optional(),
    wsPath: z.string().max(512).nullable().optional(),
    pbk: z.string().max(255).nullable().optional(),
    sid: z.string().max(64).nullable().optional(),
    spx: z.string().max(128).nullable().optional(),
    flow: z.string().max(64).nullable().optional(),
    encryption: z.string().max(32).nullable().optional(),
    alpn: z.string().max(64).nullable().optional(),
    enabled: z.boolean().optional(),
    priority: z.number().int().min(0).max(10000).optional(),
    preferred: z.boolean().optional(),
  });

  app.patch<{ Params: { id: string } }>(
    "/api/proxies/:id",
    {
      schema: {
        summary: "Update a proxy node",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Partial update — omit a field to keep it; string options accept null to " +
          "clear them. The UUID itself is immutable (vaulted secret).",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: {
          type: "object",
          properties: {
            name: { type: "string", minLength: 1, maxLength: 120 },
            server: { type: "string", minLength: 1, maxLength: 255 },
            port: { type: "integer", minimum: 1, maximum: 65535 },
            transport: { type: "string" },
            security: { type: "string" },
            sni: { type: ["string", "null"], maxLength: 255 },
            wsHost: { type: ["string", "null"], maxLength: 255 },
            wsPath: { type: ["string", "null"], maxLength: 512 },
            pbk: { type: ["string", "null"], maxLength: 255 },
            sid: { type: ["string", "null"], maxLength: 64 },
            spx: { type: ["string", "null"], maxLength: 128 },
            flow: { type: ["string", "null"], maxLength: 64 },
            encryption: { type: ["string", "null"], maxLength: 32 },
            alpn: { type: ["string", "null"], maxLength: 64 },
            enabled: { type: "boolean" },
            priority: { type: "integer", minimum: 0, maximum: 10000 },
            preferred: { type: "boolean" },
          },
        },
        response: {
          200: maskedNodeSchema,
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const body = patchNode.parse(req.body);
      const current = ctx.proxies.getOrThrow(req.params.id);
      const config: ProxyNodeConfig = {
        ...current.config,
        name: body.name ?? current.config.name,
        server: body.server ?? current.config.server,
        port: body.port ?? current.config.port,
        transport: body.transport ?? current.config.transport,
        security: body.security ?? current.config.security,
        sni: body.sni !== undefined ? (body.sni ?? undefined) : current.config.sni,
        wsHost: body.wsHost !== undefined ? (body.wsHost ?? undefined) : current.config.wsHost,
        wsPath: body.wsPath !== undefined ? (body.wsPath ?? undefined) : current.config.wsPath,
        pbk: body.pbk !== undefined ? (body.pbk ?? undefined) : current.config.pbk,
        sid: body.sid !== undefined ? (body.sid ?? undefined) : current.config.sid,
        spx: body.spx !== undefined ? (body.spx ?? undefined) : current.config.spx,
        flow: body.flow !== undefined ? (body.flow ?? undefined) : current.config.flow,
        encryption:
          body.encryption !== undefined
            ? (body.encryption ?? undefined)
            : current.config.encryption,
        alpn: body.alpn !== undefined ? (body.alpn ?? undefined) : current.config.alpn,
      };
      const node = ctx.proxies.update(req.params.id, {
        config,
        enabled: body.enabled,
        priority: body.priority,
        preferred: body.preferred,
      });
      return maskNode(node);
    },
  );

  // Batch delete (table multi-select in the UI). Same vault hygiene as the
  // single-delete: a secret is removed only when no remaining node refs it.
  app.delete(
    "/api/proxies",
    {
      schema: {
        summary: "Delete multiple proxy nodes",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Batch delete (table multi-select in the UI). Same vault hygiene as the " +
          "single-delete: a secret is removed only when no remaining node refs it.",
        body: {
          type: "object",
          required: ["ids"],
          properties: {
            ids: {
              type: "array",
              items: { type: "string" },
              minItems: 1,
              maxItems: 500,
            },
          },
        },
        response: {
          200: {
            type: "object",
            required: ["deleted"],
            properties: { deleted: { type: "integer" } },
          },
        },
      },
    },
    async (req, reply) => {
      const body = z.object({ ids: z.array(z.string().min(1)).min(1).max(500) }).parse(req.body);
      let deleted = 0;
      for (const id of new Set(body.ids)) {
        const node = ctx.proxies.get(id);
        if (!node) continue;
        ctx.proxies.delete(id);
        deleted += 1;
        const ref = node.config.uuidSecretRef;
        if (!ctx.proxies.list().some((n) => n.config.uuidSecretRef === ref)) {
          try {
            ctx.vault.delete(ref);
          } catch {
            // already gone — harmless
          }
        }
      }
      return reply.code(200).send({ deleted });
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/api/proxies/:id",
    {
      schema: {
        summary: "Delete one proxy node",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Deletes the node. The vaulted secret is removed ONLY if no remaining " +
          "node references the same secret (nodes frequently share one UUID).",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          204: { description: "No content" },
          404: { $ref: "Error" },
        },
      },
    },
    async (req, reply) => {
      const node = ctx.proxies.get(req.params.id);
      if (!node) throw new ApiError(ApiCodes.notFound, "node not found", 404);
      ctx.proxies.delete(req.params.id);
      // Remove the vaulted secret ONLY if no remaining node references the same
      // secret. Nodes frequently share one UUID (same provider key), so an
      // unconditional delete would wipe the key for every sibling node.
      const ref = node.config.uuidSecretRef;
      const stillUsed = ctx.proxies.list().some((n) => n.config.uuidSecretRef === ref);
      if (!stillUsed) {
        try {
          ctx.vault.delete(ref);
        } catch {
          // already gone — harmless
        }
      }
      return reply.code(204).send();
    },
  );

  // Validate config only (no network).
  app.post<{ Params: { id: string } }>(
    "/api/proxies/:id/validate",
    {
      schema: {
        summary: "Validate a node's config (no network)",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description: "Static config validation only — no tunnel, no network traffic.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            required: ["valid", "issues"],
            properties: {
              valid: { type: "boolean" },
              issues: { type: "array", items: { type: "string" } },
            },
          },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const node = ctx.proxies.getOrThrow(req.params.id);
      return ctx.proxyManager.validateConfig(node);
    },
  );

  // Runtime availability (binary present? configured?).
  app.get(
    "/api/proxies/runtime",
    {
      schema: {
        summary: "Proxy runtime status",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description: "Runtime availability: binary present? configured?",
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            properties: {
              state: { type: "string" },
              name: { type: "string" },
              reason: { type: "string" },
            },
          },
        },
      },
    },
    async () => ctx.runtime.status(),
  );

  // Full STAGED health check (config -> runtime -> tunnel -> REAL fetch
  // through the tunnel), SSRF-guarded. `target` selects the destination:
  //   "egress"      (default) — first allowlist entry (an IP-echo service)
  //   "notebooklm"        — notebooklm.google.com:443 (real target proof)
  // Both targets must be allowlisted; anything else is refused (SSRF guard).
  const healthBody = z
    .object({
      target: z.enum(["egress", "notebooklm"]).optional(),
    })
    .optional();
  app.post<{ Params: { id: string } }>(
    "/api/proxies/:id/health",
    {
      schema: {
        summary: "Run the full staged health check on one node",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Full staged health check (config -> runtime -> tunnel -> REAL fetch " +
          "through the tunnel), SSRF-guarded. `target` selects the destination: " +
          '"egress" (default, first allowlist entry) or "notebooklm" ' +
          "(notebooklm.google.com:443). Both targets must be allowlisted.",
        params: { type: "object", properties: { id: { type: "string" } } },
        body: {
          type: "object",
          properties: { target: { type: "string", enum: ["egress", "notebooklm"] } },
        },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            required: ["node", "ok"],
            properties: {
              node: proxyListRowSchema,
              ok: { type: "boolean" },
              egressIp: { type: ["string", "null"] },
              latencyMs: { type: ["number", "null"] },
              error: { type: ["string", "null"] },
              category: { type: "string" },
              target: { type: ["string", "null"] },
              evidence: { type: ["string", "null"] },
              startedAt: { type: "string" },
            },
          },
          404: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const node = ctx.proxies.getOrThrow(req.params.id);
      const body = healthBody?.parse(req.body ?? {});
      const dest =
        body?.target === "notebooklm"
          ? { host: "notebooklm.google.com", port: 443 }
          : destFromAllowlist(ctx);
      const result = await ctx.proxyManager.runHealthCheck(node.id, dest);
      const refreshed = ctx.proxies.get(node.id);
      if (!refreshed) throw new ApiError(ApiCodes.notFound, "node not found", 404);
      // Include the persisted health row so the UI can merge the response
      // straight into its list (a bare maskNode would carry no health).
      return {
        node: { ...maskNode(refreshed), health: ctx.proxies.health(refreshed.id) },
        ...result,
      };
    },
  );

  // Connectivity test through the tunnel (no egress IP assertion).
  app.post<{ Params: { id: string } }>(
    "/api/proxies/:id/connectivity",
    {
      schema: {
        summary: "Test connectivity through the tunnel",
        tags: ["proxies"],
        security: ADMIN_SECURITY,
        description:
          "Starts the tunnel for the node and reports the local proxy handle " +
          "(no egress-IP assertion). 503 when the runtime is not configured.",
        params: { type: "object", properties: { id: { type: "string" } } },
        response: {
          200: {
            type: "object",
            additionalProperties: true,
            required: ["ok"],
            properties: {
              ok: { type: "boolean" },
              handle: {
                type: "object",
                properties: {
                  host: { type: "string" },
                  port: { type: "integer" },
                },
              },
              error: { type: "string" },
            },
          },
          404: { $ref: "Error" },
          503: { $ref: "Error" },
        },
      },
    },
    async (req) => {
      const node = ctx.proxies.getOrThrow(req.params.id);
      const status = ctx.runtime.status();
      if (status.state === "not_configured") {
        throw new ApiError(ApiCodes.runtimeNotConfigured, status.reason, 503);
      }
      try {
        const handle = await ctx.runtime.startTunnel(node, (ref) => ctx.vault.get(ref));
        await ctx.runtime.stopTunnel(node.id);
        return { ok: true, handle: { host: handle.host, port: handle.port } };
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
    },
  );
}

/** Run an async map over items with at most `limit` concurrent tasks. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      const item = items[i] as T;
      out[i] = await fn(item);
    }
  });
  await Promise.all(workers);
  return out;
}

function destFromAllowlist(ctx: AppContext): { host: string; port: number } {
  const first = ctx.config.healthAllowlist[0];
  if (!first) return { host: "api.ipify.org", port: 443 };
  const [host, portStr] = first.includes(":") ? first.split(":") : [first, "443"];
  return { host: (host as string).replace(/^\[|\]$/g, ""), port: Number(portStr) || 443 };
}

/** Connection-identity key: the fields that actually select the server. */
function identityKey(c: ProxyNodeConfig): string {
  return [c.server, c.port, c.transport, c.security, c.wsHost ?? "", c.wsPath ?? ""].join("|");
}

/** Mask a node: UUID shown only in masked form; never the secret value. */
function maskNode(node: {
  id: string;
  config: ProxyNodeConfig;
  enabled: boolean;
  priority: number;
  preferred: boolean;
  createdAt: string;
  updatedAt: string;
}) {
  const { uuidSecretRef, ...cfg } = node.config;
  const uuid = uuidSecretRef.replace(/^vless-uuid:/, "");
  return {
    id: node.id,
    enabled: node.enabled,
    priority: node.priority,
    preferred: node.preferred,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    config: {
      ...cfg,
      uuidMasked: maskUuid(uuid),
    },
  };
}
