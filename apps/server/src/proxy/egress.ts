/**
 * Fail-closed egress transport for provider traffic.
 *
 * This is the SECURITY BOUNDARY: the provider worker may only send traffic
 * through a local tunnel handle. There is no `direct` mode. If the tunnel is
 * absent or broken, the transport REJECTS the request (throw) — it never
 * silently connects to the upstream host.
 *
 * The mock transport below implements the same contract and records every
 * attempt so tests can assert that no direct dial ever happened.
 */

import type { TunnelHandle } from "./runtime.js";

export class DirectEgressBlockedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DirectEgressBlockedError";
  }
}

export interface EgressAttempt {
  viaTunnel: boolean;
  tunnelNodeId: string | null;
  target: string;
  ok: boolean;
  error?: string;
}

export interface ProviderEgress {
  /**
   * Perform a request on behalf of the provider.
   * @param tunnel - the ONLY permitted route. `null` is treated as a failure.
   * @param target - upstream host:port (must be a configured destination).
   * @param body - request payload (opaque to this layer).
   */
  request(
    tunnel: TunnelHandle | null,
    target: string,
    body: { method: string; path: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; latencyMs: number }>;

  /** Test observability: every attempt recorded. */
  attempts: EgressAttempt[];
}

/**
 * Mock egress for the mock runtime. Behavior:
 *  - tunnel present + mock runtime "up"      -> succeeds (200), via tunnel
 *  - tunnel present + scenario crash/down    -> fails with connectivity error
 *  - tunnel present + dns_fail/timeout       -> fails accordingly
 *  - tunnel ABSENT                           -> ALWAYS fails (fail-closed)
 * The mock also accepts an injectable `dial` for the "up" path so tests can
 * simulate an arbitrary upstream.
 */
export class MockProviderEgress implements ProviderEgress {
  attempts: EgressAttempt[] = [];
  private scenarioFor: (nodeId: string) => string;

  constructor(
    private readonly dial: (
      via: TunnelHandle,
      target: string,
      body: { method: string; path: string; headers: Record<string, string>; body?: string },
    ) => Promise<{ status: number; body: string }>,
    scenarioFor: (nodeId: string) => string,
  ) {
    this.scenarioFor = scenarioFor;
  }

  async request(
    tunnel: TunnelHandle | null,
    target: string,
    body: { method: string; path: string; headers: Record<string, string>; body?: string },
  ): Promise<{ status: number; body: string; latencyMs: number }> {
    if (!tunnel) {
      this.attempts.push({
        viaTunnel: false,
        tunnelNodeId: null,
        target,
        ok: false,
        error: "no tunnel (fail-closed)",
      });
      throw new DirectEgressBlockedError(
        "provider egress requires an approved tunnel; no tunnel available (fail-closed, refusing direct connection)",
      );
    }

    const scenario = this.scenarioFor(tunnel.nodeId);
    const started = Date.now();
    try {
      if (scenario === "down" || scenario === "crash") {
        const err = `tunnel ${scenario} (node ${tunnel.nodeId})`;
        this.attempts.push({
          viaTunnel: true,
          tunnelNodeId: tunnel.nodeId,
          target,
          ok: false,
          error: err,
        });
        throw new Error(err);
      }
      if (scenario === "dns_fail") {
        this.attempts.push({
          viaTunnel: true,
          tunnelNodeId: tunnel.nodeId,
          target,
          ok: false,
          error: "dns failure via tunnel",
        });
        throw new Error("dns failure via tunnel");
      }
      if (scenario === "timeout") {
        this.attempts.push({
          viaTunnel: true,
          tunnelNodeId: tunnel.nodeId,
          target,
          ok: false,
          error: "upstream timeout via tunnel",
        });
        throw new Error("upstream timeout via tunnel");
      }
      const res = await this.dial(tunnel, target, body);
      this.attempts.push({ viaTunnel: true, tunnelNodeId: tunnel.nodeId, target, ok: true });
      return { ...res, latencyMs: Date.now() - started };
    } catch (err) {
      if (err instanceof DirectEgressBlockedError) throw err;
      throw err;
    }
  }
}

/**
 * The real egress implementation (for the python worker) must enforce the
 * same contract: configure the child process env with proxy vars pointing at
 * the local tunnel listener ONLY, and fail the job if the tunnel is down.
 * That executor is implemented in the provider layer (phase 4).
 */
