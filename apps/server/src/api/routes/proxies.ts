import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes, parseVlessUri, maskUuid, type ProxyNodeConfig } from "@nlo/shared";
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

export function registerProxyRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Add by URI (recommended): secret (UUID) goes straight to the vault.
  app.post("/api/proxies", async (req, reply) => {
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
  });

  // Add manually (all fields provided; UUID still vaulted).
  app.post("/api/proxies/manual", async (req, reply) => {
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
  });

  // List with the persisted per-node health (last check), so the UI can
  // show a latency column without running fresh checks on load.
  app.get("/api/proxies", async () =>
    ctx.proxies.list().map((n) => ({ ...maskNode(n), health: ctx.proxies.health(n.id) })),
  );

  // Ping ALL nodes with a bounded concurrency. Each check is the same
  // staged, SSRF-guarded health check as the single-node endpoint and
  // persists its own health row, so a subsequent list call reflects the
  // fresh latencies. Destination: notebooklm.google.com:443 when it is
  // allowlisted (the default), otherwise the first allowlist entry — the
  // SSRF guard only permits allowlisted targets, and tests use a fixed-IP
  // allowlist that deliberately excludes the real host.
  app.post("/api/proxies/ping-all", async () => {
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
  });

  app.get<{ Params: { id: string } }>("/api/proxies/:id", async (req) => {
    const n = ctx.proxies.get(req.params.id);
    if (!n) throw new ApiError(ApiCodes.notFound, "node not found", 404);
    return {
      node: maskNode(n),
      health: ctx.proxies.health(n.id),
      history: ctx.proxies.history(n.id),
    };
  });

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

  app.patch<{ Params: { id: string } }>("/api/proxies/:id", async (req) => {
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
        body.encryption !== undefined ? (body.encryption ?? undefined) : current.config.encryption,
      alpn: body.alpn !== undefined ? (body.alpn ?? undefined) : current.config.alpn,
    };
    const node = ctx.proxies.update(req.params.id, {
      config,
      enabled: body.enabled,
      priority: body.priority,
      preferred: body.preferred,
    });
    return maskNode(node);
  });

  app.delete<{ Params: { id: string } }>("/api/proxies/:id", async (req, reply) => {
    const node = ctx.proxies.get(req.params.id);
    if (!node) throw new ApiError(ApiCodes.notFound, "node not found", 404);
    // Remove the vaulted secret too.
    ctx.vault.delete(node.config.uuidSecretRef);
    ctx.proxies.delete(req.params.id);
    return reply.code(204).send();
  });

  // Validate config only (no network).
  app.post<{ Params: { id: string } }>("/api/proxies/:id/validate", async (req) => {
    const node = ctx.proxies.getOrThrow(req.params.id);
    return ctx.proxyManager.validateConfig(node);
  });

  // Runtime availability (binary present? configured?).
  app.get("/api/proxies/runtime", async () => ctx.runtime.status());

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
  app.post<{ Params: { id: string } }>("/api/proxies/:id/health", async (req) => {
    const node = ctx.proxies.getOrThrow(req.params.id);
    const body = healthBody?.parse(req.body ?? {});
    const dest =
      body?.target === "notebooklm"
        ? { host: "notebooklm.google.com", port: 443 }
        : destFromAllowlist(ctx);
    const result = await ctx.proxyManager.runHealthCheck(node.id, dest);
    const refreshed = ctx.proxies.get(node.id);
    if (!refreshed) throw new ApiError(ApiCodes.notFound, "node not found", 404);
    return { node: maskNode(refreshed), ...result };
  });

  // Connectivity test through the tunnel (no egress IP assertion).
  app.post<{ Params: { id: string } }>("/api/proxies/:id/connectivity", async (req) => {
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
  });
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
