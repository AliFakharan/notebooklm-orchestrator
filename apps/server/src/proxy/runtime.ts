import { createServer, type Server } from "node:net";
import { AddressInfo } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import path from "node:path";
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
  /** Release all tunnels/processes. No-op for stateless runtimes. */
  close(): Promise<void>;
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

  async close(): Promise<void> {
    for (const id of [...this.tunnels.keys()]) await this.stopTunnel(id);
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
 * REAL Xray runtime.
 *
 * startTunnel:
 *   - resolves the node's VLESS UUID from the secret vault (never logged)
 *   - writes a 0600 Xray config into the data dir: ONE loopback inbound
 *     (protocol "http" — accepts CONNECT) routed to a single VLESS outbound
 *     built from the node's transport/security parameters
 *   - spawns `xray` (official binary from data/vendor/, no system install)
 *     in its own process group; the listener binds 127.0.0.1:0 (ephemeral)
 *   - waits for xray's "listener started at host:port" log line (10s budget)
 *
 * stopTunnel: SIGTERM the group, escalate to SIGKILL, remove the config.
 *
 * The local HTTP listener is a REAL proxy: CONNECT through it must produce a
 * working TLS session to the destination. That is what healthCheck verifies
 * via the injected `fetchThrough` (a real CONNECT+TLS fetcher in production).
 */
export class XrayProxyRuntime implements ProxyRuntime {
  readonly name = "xray";
  private tunnels = new Map<
    string,
    { proc: ChildProcess; cfgPath: string; host: string; port: number }
  >();

  constructor(
    private readonly binPath: string,
    private readonly cfgDir: string,
    private readonly log: (line: string) => void = () => {},
  ) {}

  status(): RuntimeStatus {
    if (!existsSync(this.binPath)) {
      return {
        state: "not_configured",
        name: "xray",
        reason: `Xray binary not found at ${this.binPath}. Install it (data/vendor/) and re-select this runtime.`,
      };
    }
    return { state: "available", name: "xray" };
  }

  private buildXrayConfig(node: ProxyNode, uuid: string): string {
    const cfg = node.config;
    const user: Record<string, unknown> = { id: uuid, encryption: "none" };
    if (cfg.flow) user["flow"] = cfg.flow;

    const stream: Record<string, unknown> = { network: cfg.transport };
    if (cfg.security === "tls") {
      stream["security"] = "tls";
      stream["tlsSettings"] = {
        serverName: cfg.sni ?? cfg.server,
        ...(cfg.alpn ? { alpn: cfg.alpn.split(",").map((s) => s.trim()) } : {}),
      };
    } else if (cfg.security === "reality") {
      stream["security"] = "reality";
      stream["realitySettings"] = {
        serverName: cfg.sni ?? cfg.server,
        fingerprint: "chrome",
        publicKey: cfg.pbk ?? "",
        shortId: cfg.sid ?? "",
        ...(cfg.spx ? { spiderX: cfg.spx } : {}),
      };
    }
    if (cfg.transport === "ws") {
      stream["wsSettings"] = {
        path: cfg.wsPath ?? "/",
        headers: cfg.wsHost ? { Host: cfg.wsHost } : {},
      };
    }
    if (cfg.transport === "grpc") {
      stream["grpcSettings"] = {
        serviceName: (cfg.extra["serviceName"] ?? "").trim() || "grpc",
      };
    }

    const config = {
      log: { loglevel: "warning" },
      inbounds: [
        {
          tag: "nlo-local-http",
          listen: "127.0.0.1",
          port: 0,
          protocol: "http",
        },
      ],
      outbounds: [
        {
          tag: "nlo-vless",
          protocol: "vless",
          settings: {
            vnext: [{ address: cfg.server, port: cfg.port, users: [user] }],
          },
          streamSettings: stream,
        },
        { tag: "nlo-direct", protocol: "freedom" },
      ],
      routing: {
        rules: [{ inboundTag: ["nlo-local-http"], outboundTag: "nlo-vless" }],
      },
    };
    return JSON.stringify(config, null, 2);
  }

  async startTunnel(node: ProxyNode, getSecret: (ref: string) => string): Promise<TunnelHandle> {
    const existing = this.tunnels.get(node.id);
    if (existing) return { nodeId: node.id, host: existing.host, port: existing.port };

    const status = this.status();
    if (status.state !== "available") {
      throw new ProxyRuntimeError((status as { reason: string }).reason, "runtime_not_configured");
    }
    const uuid = getSecret(node.config.uuidSecretRef);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(uuid)) {
      throw new ProxyRuntimeError("stored uuid failed validation", "bad_secret");
    }

    mkdirSync(this.cfgDir, { recursive: true, mode: 0o700 });
    const cfgPath = path.join(this.cfgDir, `xray-${node.id}.json`);
    writeFileSync(cfgPath, this.buildXrayConfig(node, uuid), { mode: 0o600 });

    const proc = spawn(this.binPath, ["-c", cfgPath, "--loglevel", "info"], {
      stdio: ["ignore", "ignore", "pipe"],
      detached: process.platform !== "win32",
      env: { ...process.env },
    });

    const port = await new Promise<number>((resolve, reject) => {
      let buf = "";
      const timer = setTimeout(() => {
        cleanup();
        reject(
          new ProxyRuntimeError(
            "xray did not start its listener within 10s",
            "runtime_start_timeout",
          ),
        );
      }, 10_000);
      const onErr = (err: Error) => {
        cleanup();
        clearTimeout(timer);
        reject(new ProxyRuntimeError(`xray process error: ${err.message}`, "runtime_error"));
      };
      const cleanup = () => {
        proc.stderr?.off("data", onData);
        proc.off("error", onErr);
        proc.off("exit", onExit);
      };
      const onData = (chunk: Buffer) => {
        buf += chunk.toString("utf8");
        if (buf.length > 1_000_000) buf = buf.slice(-100_000);
        const m = buf.match(/listener started at ([\d.]+):(\d+)/);
        if (m) {
          clearTimeout(timer);
          cleanup();
          resolve(Number(m[2]));
          return;
        }
        if (/error:|fatal:|panic:/i.test(buf.slice(-4000))) {
          const tail = buf.slice(-600).replace(/\s+/g, " ");
          cleanup();
          clearTimeout(timer);
          reject(new ProxyRuntimeError(`xray failed to start: ${tail}`, "runtime_error"));
        }
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        clearTimeout(timer);
        reject(
          new ProxyRuntimeError(
            `xray exited early (code=${code}, signal=${signal ?? "none"})`,
            "runtime_error",
          ),
        );
      };
      proc.stderr?.on("data", onData);
      proc.on("error", onErr);
      proc.on("exit", onExit);
    }).catch((e) => {
      this.killProc(proc);
      try {
        rmSync(cfgPath, { force: true });
      } catch {
        /* ignore */
      }
      throw e;
    });

    proc.on("exit", () => {
      // Unexpected death: drop the tunnel so the next selection sees it.
      if (this.tunnels.get(node.id)?.proc === proc) {
        this.tunnels.delete(node.id);
        try {
          rmSync(cfgPath, { force: true });
        } catch {
          /* ignore */
        }
        this.log(`xray tunnel for ${node.config.name} exited unexpectedly`);
      }
    });

    this.tunnels.set(node.id, { proc, cfgPath, host: "127.0.0.1", port });
    this.log(`xray tunnel up for ${node.config.name} on 127.0.0.1:${port} (pid=${proc.pid})`);
    return { nodeId: node.id, host: "127.0.0.1", port };
  }

  private killProc(proc: ChildProcess): void {
    if (proc.pid === undefined) return;
    const pid = proc.pid;
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
      else proc.kill("SIGTERM");
    } catch {
      /* gone */
    }
    setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }, 4000).unref?.();
  }

  async stopTunnel(nodeId: string): Promise<void> {
    const t = this.tunnels.get(nodeId);
    if (!t) return;
    this.tunnels.delete(nodeId);
    this.killProc(t.proc);
    try {
      rmSync(t.cfgPath, { force: true });
    } catch {
      /* ignore */
    }
  }

  async close(): Promise<void> {
    for (const id of [...this.tunnels.keys()]) await this.stopTunnel(id);
  }

  /**
   * Real health: the injected `fetchThrough` performs an actual CONNECT + TLS
   * request via the tunnel. When the destination is an egress-IP echo service,
   * its body (the observed public IP) is returned as `egressIp` — measured,
   * never invented.
   */
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
    const started = Date.now();
    const res = await fetchThrough(handle, dest);
    const latencyMs = Date.now() - started;
    if (!res.ok) {
      return {
        ok: false,
        egressIp: null,
        latencyMs,
        error: res.error ?? "fetch through tunnel failed",
      };
    }
    const body = (res.body ?? "").trim();
    const looksLikeIp =
      /^\d{1,3}(\.\d{1,3}){3}([:/].*)?$/.test(body) || /^\d{1,3}(\.\d{1,3}){3}$/.test(body);
    const isEcho = /ipify|ifconfig|ip\.|public-ip|api\.ip/.test(dest.host);
    const egressIp = isEcho && looksLikeIp ? (body.split(/[:/\s]/)[0] ?? null) : null;
    return { ok: true, egressIp, latencyMs, error: null };
  }
}

/**
 * Factory: real runtime when the binary exists, otherwise the safe stub
 * (never a "working" runtime — it reports not_configured and fails closed).
 */
export function createXrayProxyRuntime(opts: {
  vendorDir: string;
  binPath?: string;
  log?: (line: string) => void;
}): ProxyRuntime {
  const binPath = opts.binPath ?? path.join(opts.vendorDir, "xray");
  const log = opts.log ?? (() => {});
  if (existsSync(binPath)) {
    log(`xray runtime enabled: ${binPath}`);
    return new XrayProxyRuntime(binPath, path.join(opts.vendorDir, "cfg"), log);
  }
  log("xray binary not found — using safe stub (not_configured, fail-closed)");
  return new XrayProxyRuntimeStub();
}

/**
 * Xray runtime stub. Kept as the safe fallback when no binary is present:
 * it reports `not_configured` and every operation fails closed — it is never
 * a working runtime and never fabricates health.
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

  async close(): Promise<void> {
    // nothing to release
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
