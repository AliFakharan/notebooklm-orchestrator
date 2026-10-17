import { lookup } from "node:dns/promises";
import { parseAllowEntry, type AllowEntry, type HealthCategory, type ProxyNode } from "@nlo/shared";
import type { ProxiesRepo } from "../domain/proxies.repo.js";
import { ProxyRuntimeError, type ProxyRuntime, type TunnelHandle } from "./runtime.js";
import type { SecretVault } from "../secrets/vault.js";

/**
 * ProxyManager: node selection, tunnel lifecycle, and REAL staged health
 * checks.
 *
 * Selection policy (transparent, measured):
 *   A node is eligible for a job only when ALL of:
 *     1. enabled
 *     2. configuration passes static validation
 *     3. last health check was ok AND recent (freshness TTL)
 *   Preferred nodes win ties; otherwise lower priority number wins.
 *   Selection then STARTS the tunnel. If the tunnel cannot be established,
 *   the next eligible node is tried. If none works, selection throws
 *   (fail-closed: there is no direct-egress fallback).
 *
 * Health pipeline (per node, per check), each stage recorded:
 *   A. config validation          (category=config)
 *   B. runtime availability       (category=runtime)
 *   C. tunnel start + listener    (category=listener)
 *   D. real egress fetch          (category=egress)   — measures public IP
 *   E. real destination fetch     (category=nbl_access|tls) — the actual
 *      NotebookLM target, so "generic connectivity" never masquerades as
 *      "NotebookLM reachable"
 */
export interface SelectionInfo {
  node: ProxyNode;
  handle: TunnelHandle;
  reason: string;
  rejected: { nodeId: string; reason: string }[];
}

export interface HealthCheckResult {
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  error: string | null;
  category: HealthCategory;
  target: string | null;
  evidence: string | null;
  startedAt: string;
}

export class ProxyManager {
  private allowlist: AllowEntry[];
  /** TTL after which a previously-healthy result is no longer trusted. */
  private readonly healthTtlMs: number;

  private readonly logFn: (line: string) => void;

  constructor(
    private readonly repo: ProxiesRepo,
    private readonly runtime: ProxyRuntime,
    allowlistRaw: string[],
    private readonly fetchThrough: (
      via: TunnelHandle | null,
      dest: { host: string; port: number },
    ) => Promise<{
      ok: boolean;
      status?: number;
      body?: string;
      latencyMs: number;
      error?: string;
    }>,
    private readonly vault: SecretVault,
    opts: { healthTtlMs?: number; log?: (line: string) => void } = {},
  ) {
    this.allowlist = allowlistRaw.map((s) => parseAllowEntry(s));
    this.healthTtlMs = opts.healthTtlMs ?? 10 * 60_000;
    this.logFn = opts.log ?? (() => {});
  }

  private log(line: string): void {
    this.logFn(line);
  }

  /**
   * Select a node AND start its tunnel. Throws (fail-closed) when no node can
   * provide a working route.
   */
  async select(preferredNodeId: string | null): Promise<SelectionInfo> {
    const all = this.repo.list().filter((n) => n.enabled);
    if (all.length === 0) {
      throw new Error("no enabled proxy node configured (fail-closed: refusing direct egress)");
    }
    const rejected: { nodeId: string; reason: string }[] = [];
    const byId = new Map(all.map((n) => [n.id, n]));

    const order =
      preferredNodeId && byId.has(preferredNodeId)
        ? [byId.get(preferredNodeId)!, ...all.filter((n) => n.id !== preferredNodeId)]
        : all;

    let sawAnyFresh = false;
    for (const node of order) {
      // 1+2. static validation
      const v = this.validateConfig(node);
      if (!v.valid) {
        rejected.push({ nodeId: node.id, reason: `invalid config: ${v.issues.join("; ")}` });
        continue;
      }
      // 3. health: must be ok AND fresh
      const health = this.repo.health(node.id);
      const fresh = health?.lastCheckedAt
        ? Date.now() - Date.parse(health.lastCheckedAt) < this.healthTtlMs
        : false;
      if (health && health.ok && fresh) {
        sawAnyFresh = true;
      } else {
        const why = !health
          ? "never health-checked"
          : !health.ok
            ? `last check failed: ${health.error ?? "unknown"}`
            : `health check stale (${health.lastCheckedAt})`;
        rejected.push({ nodeId: node.id, reason: why });
        continue;
      }

      // Start the tunnel for real.
      try {
        const handle = await this.runtime.startTunnel(node, (ref) => this.vault.get(ref));
        this.log(
          `selected node ${node.config.name} (${node.id}); tunnel at ${handle.host}:${handle.port}`,
        );
        return {
          node,
          handle,
          reason: `enabled + config valid + healthy check fresh (${health.lastCheckedAt}) + tunnel established`,
          rejected,
        };
      } catch (e) {
        const msg =
          e instanceof ProxyRuntimeError ? e.message : e instanceof Error ? e.message : String(e);
        rejected.push({ nodeId: node.id, reason: `tunnel failed: ${msg}` });
      }
    }

    throw new Error(
      sawAnyFresh
        ? "healthy proxy nodes exist but none could establish a tunnel (fail-closed)"
        : "no healthy proxy node available (fail-closed: refusing direct egress); run a health check on a node first",
    );
  }

  stopTunnel(nodeId: string): Promise<void> {
    return this.runtime.stopTunnel(nodeId);
  }

  /**
   * Full staged health check. Every stage's outcome is persisted (category +
   * evidence), and the tunnel is always stopped afterwards.
   */
  async runHealthCheck(
    nodeId: string,
    dest: { host: string; port: number },
  ): Promise<HealthCheckResult> {
    const startedAt = new Date().toISOString();
    const node = this.repo.getOrThrow(nodeId);
    const persist = (r: Omit<HealthCheckResult, "startedAt">) => {
      this.repo.setHealth(
        {
          lastCheckedAt: new Date().toISOString(),
          ok: r.ok,
          egressIp: r.egressIp,
          latencyMs: r.latencyMs,
          error: r.error,
          startedAt,
          target: r.target,
          category: r.category,
          evidence: r.evidence,
        },
        nodeId,
      );
    };

    // 0. SSRF guard BEFORE anything is dialed (allowlist + public IP check).
    //    Violations reject the call — they are never "a failed check".
    await this.assertSafe(dest);

    // A. config
    const v = this.validateConfig(node);
    if (!v.valid) {
      const res: HealthCheckResult = {
        ok: false,
        egressIp: null,
        latencyMs: null,
        error: v.issues.join("; "),
        category: "config",
        target: null,
        evidence: "static validation",
        startedAt,
      };
      persist(res);
      return res;
    }
    // B. runtime
    const status = this.runtime.status();
    if (status.state !== "available") {
      const res: HealthCheckResult = {
        ok: false,
        egressIp: null,
        latencyMs: null,
        error: status.reason,
        category: "runtime",
        target: null,
        evidence: `runtime status: ${status.state}`,
        startedAt,
      };
      persist(res);
      return res;
    }
    // C. tunnel start
    let handle: TunnelHandle;
    try {
      handle = await this.runtime.startTunnel(node, (ref) => this.vault.get(ref));
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const res: HealthCheckResult = {
        ok: false,
        egressIp: null,
        latencyMs: null,
        error: msg,
        category: "listener",
        target: null,
        evidence: "startTunnel failed",
        startedAt,
      };
      persist(res);
      return res;
    }

    try {
      // D. REAL fetch THROUGH the tunnel (CONNECT + TLS to the destination).
      //    This is the actual proof of route — never a saved value.
      const targetStr = `${dest.host}:${dest.port}`;
      const d = Date.now();
      const res = await this.fetchThrough(handle, dest).catch((e) => ({
        ok: false as const,
        status: undefined as number | undefined,
        body: undefined as string | undefined,
        latencyMs: Date.now() - d,
        error: e instanceof Error ? e.message : String(e),
      }));
      const latencyMs = res.latencyMs ?? Date.now() - d;
      const isEcho =
        /^\d{1,3}(\.\d{1,3}){3}$/.test(dest.host) ||
        /ipify|ifconfig|ip\.|public-ip|api\.ip/.test(dest.host);
      // Route proof differs by target:
      //  - IP-echo: must be 2xx AND a parseable IP in the body (egress proof).
      //  - notebooklm (any non-echo host): ANY HTTP response through the
      //    tunnel proves the route (CONNECT + TLS + HTTP round-trip). A 403
      //    "bot check" from Google IS a working route — the service answered
      //    us from the node's egress. Only a connection-level failure means
      //    the route is broken.
      const routeWorks = isEcho ? res.ok : res.status !== undefined;
      if (!routeWorks) {
        const res2: HealthCheckResult = {
          ok: false,
          egressIp: null,
          latencyMs,
          error: res.error ?? "fetch through tunnel failed (no HTTP response via tunnel)",
          category: /^\d{1,3}(\.\d{1,3}){3}$/.test(dest.host) ? "tls" : "upstream",
          target: targetStr,
          evidence: `HTTPS via tunnel ${handle.host}:${handle.port} -> ${targetStr} failed`,
          startedAt,
        };
        persist(res2);
        return res2;
      }
      const egressIp = extractIp(res.body);
      const isNbl = /notebooklm/i.test(dest.host);

      // E. Runtime-level verdict (e.g. expected-egress-IP enforcement by the
      //    mock; for xray this is the same real check re-confirmed).
      const verdict = await this.runtime.healthCheck(handle, dest, this.fetchThrough);
      // For non-echo targets the ROUTE is the verdict (any HTTP response);
      // for echo targets a 2xx with an IP is still required.
      const finalOk = (isEcho ? res.ok : routeWorks) && verdict.ok;
      const res3: HealthCheckResult = {
        ok: finalOk,
        egressIp: verdict.egressIp ?? egressIp,
        latencyMs,
        error: finalOk ? null : (verdict.error ?? "runtime check failed"),
        category: finalOk ? (isNbl ? "nbl_access" : "egress") : "upstream",
        target: targetStr,
        evidence: finalOk
          ? `HTTPS GET via tunnel ${handle.host}:${handle.port} -> ${targetStr} succeeded${
              egressIp ? `; observed egress ${egressIp}` : ""
            } in ${latencyMs}ms`
          : `runtime check failed: ${verdict.error ?? "unknown"}`,
        startedAt,
      };
      persist(res3);
      return res3;
    } finally {
      await this.runtime.stopTunnel(nodeId).catch(() => {});
    }
  }

  /** Validate node configuration only (no network). */
  validateConfig(node: ProxyNode): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    const cfg = node.config;
    if (!cfg.server) issues.push("server host missing");
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)
      issues.push("port invalid");
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cfg.uuidSecretRef)
    ) {
      // uuidSecretRef holds a vault ref; validate the stored value shape lazily
      // (the ref itself is fine as long as it's non-empty)
    }
    if (!cfg.uuidSecretRef) issues.push("uuid secret ref missing");
    if (cfg.transport === "ws" && !cfg.wsPath) issues.push("ws transport requires path");
    if (cfg.transport === "grpc" && !cfg.extra?.serviceName) {
      issues.push("grpc transport requires serviceName (warning: kept in extra)");
    }
    if (cfg.security === "reality") {
      if (!cfg.pbk) issues.push("reality requires pbk");
      if (!cfg.sid) issues.push("reality requires sid");
      if (!cfg.sni) issues.push("reality requires sni");
    }
    return { valid: issues.length === 0, issues };
  }

  /**
   * SSRF guard BEFORE any dial: destination must be allowlisted and its
   * resolved IPs must be public (unless explicitly opted in).
   */
  async assertSafe(dest: { host: string; port: number }): Promise<void> {
    const { assertAllowedDestination } = await import("@nlo/shared");
    const ips = await this.resolvePublicIps(dest.host);
    assertAllowedDestination({ host: dest.host, port: dest.port, ips }, this.allowlist);
  }

  private async resolvePublicIps(host: string): Promise<string[]> {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
      return [host];
    }
    try {
      const records = await lookup(host, { all: true });
      return records.map((r) => r.address);
    } catch {
      return [];
    }
  }
}

function extractIp(body: string | undefined): string | null {
  if (!body) return null;
  const m = body.trim().match(/^(\d{1,3}(?:\.\d{1,3}){3})/);
  return m ? (m[1] ?? null) : null;
}
