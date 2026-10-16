import { createServer, type Server } from "node:net";
import { AddressInfo } from "node:net";
import type { ProxyNode } from "@nlo/shared";

/**
 * Proxy runtime abstraction.
 *
 * Contract:
 *  - `startTunnel` exposes a LOCAL listener (127.0.0.1, ephemeral port) that
 *    the provider worker is allowed to dial. There is NO direct path: if the
 *    tunnel cannot be established, the call rejects and the caller must fail
 *    the job (fail-closed).
 *  - `stopTunnel` tears the listener down.
 *  - `status` reports whether the runtime is configured/available.
 *
 * The real Xray runtime is NOT implemented yet (requires binary + approval).
 * `MockProxyRuntime` implements the same contract deterministically and is
 * used by tests and the default (safe) configuration.
 */

export type TunnelHandle = {
  nodeId: string;
  host: string;
  port: number;
};

export type RuntimeStatus =
  { state: "available"; name: string } | { state: "not_configured"; name: string; reason: string };

export class ProxyRuntimeError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "ProxyRuntimeError";
  }
}

export interface ProxyRuntime {
  readonly name: string;
  status(): RuntimeStatus;
  startTunnel(node: ProxyNode, getSecret: (ref: string) => string): Promise<TunnelHandle>;
  stopTunnel(nodeId: string): Promise<void>;
  /**
   * Health check performed THROUGH the tunnel. `fetchThrough` is injected so
   * the runtime stays decoupled from the HTTP layer and tests can observe
   * exactly where traffic went.
   */
  healthCheck(
    handle: TunnelHandle,
    dest: { host: string; port: number },
    fetchThrough: (
      via: TunnelHandle | null,
      dest: { host: string; port: number },
    ) => Promise<{
      ok: boolean;
      body?: string;
      latencyMs: number;
      error?: string;
    }>,
  ): Promise<{
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    error: string | null;
  }>;
}

/**
 * Deterministic mock runtime.
 *
 * Scenarios per node control startTunnel/health outcomes:
 *   up (default) | down | crash | wrong_egress | dns_fail | timeout
 */
export type MockScenario = "up" | "down" | "crash" | "wrong_egress" | "dns_fail" | "timeout";

export class MockProxyRuntime implements ProxyRuntime {
  readonly name = "mock";
  private tunnels = new Map<string, { server: Server; scenario: MockScenario }>();
  private scenarios = new Map<string, MockScenario>();
  /** Expected egress IP per node (tests). A mismatch marks the node unhealthy. */
  private expectedEgress = new Map<string, string>();
  /** Observability for tests: records every dial target. */
  readonly dialed: string[] = [];

  setScenario(nodeId: string, scenario: MockScenario): void {
    this.scenarios.set(nodeId, scenario);
  }

  setExpectedEgressIp(nodeId: string, ip: string): void {
    this.expectedEgress.set(nodeId, ip);
  }

  scenario(nodeId: string): MockScenario {
    return this.scenarios.get(nodeId) ?? "up";
  }

  status(): RuntimeStatus {
    return { state: "available", name: "mock" };
  }

  async startTunnel(node: ProxyNode, _getSecret: (ref: string) => string): Promise<TunnelHandle> {
    const scenario = this.scenario(node.id);
    if (scenario === "down") {
      throw new ProxyRuntimeError(
        `mock tunnel for ${node.config.name} is down (scenario=down)`,
        "tunnel_down",
      );
    }

    // A real local TCP listener on loopback, ephemeral port. Provider code may
    // dial ONLY this address; anything else has no route in the mock world.
    const server = await new Promise<Server>((resolve, reject) => {
      const s = createServer((socket) => {
        this.dialed.push(`127.0.0.1:${this.portOf(node.id)}`);
        if (scenario === "crash") {
          socket.destroy(new Error("mock tunnel crashed"));
          return;
        }
        // Minimal fake tunnel: echo an ack line so dials succeed.
        socket.write(`OK tunnel ${node.id}\n`);
        socket.end();
      });
      s.on("error", reject);
      s.listen(0, "127.0.0.1", () => resolve(s));
    });

    if (scenario === "crash") {
      // Start OK, then die shortly after (simulates runtime crash mid-job).
      setTimeout(() => {
        this.tunnels.get(node.id)?.server.close();
      }, 5);
    }

    const { port } = server.address() as AddressInfo;
    this.tunnels.set(node.id, { server, scenario });
    return { nodeId: node.id, host: "127.0.0.1", port };
  }

  private portOf(nodeId: string): number {
    const t = this.tunnels.get(nodeId);
    if (!t) return 0;
    return (t.server.address() as AddressInfo)?.port ?? 0;
  }

  async stopTunnel(nodeId: string): Promise<void> {
    const t = this.tunnels.get(nodeId);
    if (t) {
      await new Promise<void>((resolve) => t.server.close(() => resolve()));
      this.tunnels.delete(nodeId);
    }
  }

  async healthCheck(
    handle: TunnelHandle,
    dest: { host: string; port: number },
    fetchThrough: (
      via: TunnelHandle | null,
      dest: { host: string; port: number },
    ) => Promise<{ ok: boolean; body?: string; latencyMs: number; error?: string }>,
  ): Promise<{
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    error: string | null;
  }> {
    const scenario = this.scenario(handle.nodeId);
    const started = Date.now();

    if (scenario === "dns_fail") {
      return {
        ok: false,
        egressIp: null,
        latencyMs: Date.now() - started,
        error: "mock DNS resolution failed",
      };
    }
    if (scenario === "timeout") {
      return {
        ok: false,
        egressIp: null,
        latencyMs: Date.now() - started,
        error: "mock upstream timeout",
      };
    }

    const res = await fetchThrough(handle, dest);
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      return {
        ok: false,
        egressIp: null,
        latencyMs,
        error: res.error ?? "mock health fetch failed",
      };
    }

    const egressIp = scenario === "wrong_egress" ? "203.0.113.99" : "198.51.100.7";
    const expected = this.expectedEgress.get(handle.nodeId);
    if (expected && egressIp !== expected) {
      return { ok: false, egressIp, latencyMs, error: `egress IP mismatch (got ${egressIp})` };
    }
    return { ok: true, egressIp, latencyMs, error: null };
  }
}

/**
 * Xray runtime stub. Installing/downloading the Xray binary, validating its
 * integrity, and configuring per-tunnel listeners is a gated step that
 * requires explicit user approval (docs/proxy-design.md §7). Until then the
 * runtime reports `not_configured` and every operation fails closed.
 */
export class XrayProxyRuntimeStub implements ProxyRuntime {
  readonly name = "xray";
  status(): RuntimeStatus {
    return {
      state: "not_configured",
      name: "xray",
      reason:
        "Xray binary is not installed. This is expected: enabling the real proxy runtime requires downloading the official binary to data/vendor/ and explicit user approval. No system-wide changes were made.",
    };
  }

  async startTunnel(): Promise<TunnelHandle> {
    throw new ProxyRuntimeError("xray runtime not configured", "runtime_not_configured");
  }

  async stopTunnel(): Promise<void> {
    // nothing to stop
  }

  async healthCheck(): Promise<{
    ok: boolean;
    egressIp: string | null;
    latencyMs: number | null;
    error: string | null;
  }> {
    return {
      ok: false,
      egressIp: null,
      latencyMs: null,
      error: "xray runtime not configured",
    };
  }
}
