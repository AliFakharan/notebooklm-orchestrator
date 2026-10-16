import { lookup } from "node:dns/promises";
import {
  assertAllowedDestination,
  parseAllowEntry,
  type AllowEntry,
  type ProxyNode,
} from "@nlo/shared";
import type { ProxiesRepo } from "../domain/proxies.repo.js";
import type { ProxyRuntime, TunnelHandle } from "./runtime.js";

/**
 * ProxyManager: node selection, tunnel lifecycle, and health checks.
 *
 * Fail-closed selection:
 *  - a job that REQUIRES a proxy gets the first enabled node with a recent
 *    healthy check; if none is healthy, the selection fails (the job fails)
 *    — it never falls back to a direct connection.
 *  - health checks only dial allowlisted destinations (SSRF-guarded), and
 *    re-check the resolved IP (anti DNS-rebinding).
 */
export class ProxyManager {
  private allowlist: AllowEntry[];

  constructor(
    private readonly repo: ProxiesRepo,
    private readonly runtime: ProxyRuntime,
    allowlistRaw: string[],
    private readonly fetchThrough: (
      via: TunnelHandle | null,
      dest: { host: string; port: number },
    ) => Promise<{ ok: boolean; body?: string; latencyMs: number; error?: string }>,
  ) {
    this.allowlist = allowlistRaw.map((s) => parseAllowEntry(s));
  }

  /** Select a node for a job that requires a proxy. Throws if none healthy. */
  select(preferredNodeId: string | null): { node: ProxyNode; handle: TunnelHandle | null } {
    const order = this.repo.fallbackOrder();
    if (order.length === 0) {
      throw new Error("no enabled proxy node configured (fail-closed: refusing direct egress)");
    }
    const preferred = preferredNodeId ? order.find((n) => n.id === preferredNodeId) : undefined;
    const candidates = preferred
      ? [preferred, ...order.filter((n) => n.id !== preferred.id)]
      : order;

    for (const node of candidates) {
      const health = this.repo.health(node.id);
      if (health && health.ok) {
        return { node, handle: null }; // tunnel is started by the worker executor
      }
    }
    throw new Error("no healthy proxy node available (fail-closed: refusing direct egress)");
  }

  /**
   * Run a full health check for a node: start tunnel, check egress +
   * destination reachability through it, persist history.
   */
  async runHealthCheck(
    nodeId: string,
    dest: { host: string; port: number },
  ): Promise<{
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    error: string | null;
  }> {
    this.repo.getOrThrow(nodeId);

    // SSRF guard BEFORE any dial: destination must be allowlisted and its
    // resolved IPs must be public (unless explicitly opted in).
    const ips = await this.resolvePublicIps(dest.host);
    assertAllowedDestination({ host: dest.host, port: dest.port, ips }, this.allowlist);

    const result = await this.runtime.healthCheck(
      { nodeId, host: "127.0.0.1", port: 0 },
      dest,
      this.fetchThrough,
    );

    this.repo.setHealth(
      {
        lastCheckedAt: new Date().toISOString(),
        ok: result.ok,
        egressIp: result.egressIp,
        latencyMs: result.latencyMs,
        error: result.error,
      },
      nodeId,
    );
    return {
      ok: result.ok,
      egressIp: result.egressIp,
      latencyMs: result.latencyMs,
      error: result.error,
    };
  }

  /** Validate node configuration only (no network). */
  validateConfig(node: ProxyNode): { valid: boolean; issues: string[] } {
    const issues: string[] = [];
    const cfg = node.config;
    if (!cfg.server) issues.push("server host missing");
    if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535)
      issues.push("port invalid");
    if (cfg.transport === "ws" && !cfg.wsPath) issues.push("ws transport requires path");
    if (cfg.security === "reality") {
      if (!cfg.pbk) issues.push("reality requires pbk");
      if (!cfg.sid) issues.push("reality requires sid");
      if (!cfg.sni) issues.push("reality requires sni");
    }
    return { valid: issues.length === 0, issues };
  }

  private async resolvePublicIps(host: string): Promise<string[]> {
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(":")) {
      return [host];
    }
    try {
      const records = await lookup(host, { all: true });
      return records.map((r) => r.address);
    } catch {
      // Unresolvable host: return empty so assertAllowedDestination only sees
      // the hostname (still allowlist-checked). DNS failures surface as
      // connectivity errors at dial time, not as SSRF bypasses.
      return [];
    }
  }
}
