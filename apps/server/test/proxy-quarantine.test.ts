import { afterEach, describe, expect, it, vi } from "vitest";
import { ProxyManager, type ProxyNotifier } from "../src/proxy/proxy-manager.js";
import { addNode, makeParts, type TestParts } from "./helpers.js";

/**
 * Proxy node quarantine (plan: proxy failover + async import, Task 2).
 *
 * Only NOTEBOOKLM-destination failures count toward the auto-delete streak:
 * config / runtime / tunnel-start failures and egress-echo target failures
 * never do. At the threshold (default 3, NLO_PROXY_AUTO_DELETE_AFTER) the
 * node is auto-deleted (repo + vault hygiene) and a notification is sent.
 */

// Deterministic DNS for the NBL-host wiring test below: "notebooklm.google.com"
// must resolve to a public IP so the SSRF guard passes without a real network.
vi.mock("node:dns/promises", async () => {
  const actual = await vi.importActual<typeof import("node:dns/promises")>("node:dns/promises");
  return {
    ...actual,
    lookup: async (_host: string, opts?: unknown) => {
      const wantAll =
        typeof opts === "object" && opts !== null && "all" in opts && Boolean((opts as { all?: boolean }).all);
      const rec = { address: "93.184.216.34", family: 4 };
      return wantAll ? [rec] : rec;
    },
  };
});

class FakeNotifier implements ProxyNotifier {
  sent: string[] = [];
  async send(text: string): Promise<void> {
    this.sent.push(text);
  }
}

const NBL_DEST = { host: "notebooklm.google.com", port: 443 } as const;
const ECHO_DEST = { host: "93.184.216.34", port: 443 } as const;

interface ManagerOpts {
  fetchThrough?: (
    via: unknown,
    dest: { host: string; port: number },
  ) => Promise<{ ok: boolean; status?: number; body?: string; latencyMs: number; error?: string }>;
  notifier?: ProxyNotifier;
  autoDeleteAfter?: number;
  allowlist?: string[];
}

function makeManager(parts: TestParts, opts: ManagerOpts = {}): ProxyManager {
  return new ProxyManager(
    parts.proxies,
    parts.runtime,
    opts.allowlist ?? [`${ECHO_DEST.host}:${ECHO_DEST.port}`],
    opts.fetchThrough ??
      (async () => ({ ok: true, status: 200, body: "198.51.100.7", latencyMs: 1 })),
    parts.vault,
    {
      selfHealTarget: { host: ECHO_DEST.host, port: ECHO_DEST.port },
      notifier: opts.notifier,
      autoDeleteAfter: opts.autoDeleteAfter,
    },
  );
}

let parts: TestParts;

afterEach(() => parts.dispose());

describe("proxy node quarantine: NBL destination failures", () => {
  it("3 consecutive NBL destination failures auto-delete the node and its unreferenced secret", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    const ref = parts.proxies.getOrThrow(node.id).config.uuidSecretRef;
    expect(parts.vault.has(ref)).toBe(true);

    await parts.proxyManager.markNblDestinationFailure(node.id, "connectivity");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(1);
    expect(parts.proxies.get(node.id)).not.toBeNull();
    await parts.proxyManager.markNblDestinationFailure(node.id, "connectivity");
    expect(parts.proxies.get(node.id)).not.toBeNull();
    await parts.proxyManager.markNblDestinationFailure(node.id, "connectivity");
    // Third consecutive failure: the node is gone, and its (unreferenced) secret too.
    expect(parts.proxies.get(node.id)).toBeNull();
    expect(parts.vault.has(ref)).toBe(false);
    expect(parts.proxies.list().map((n) => n.id)).not.toContain(node.id);
  });

  it("a success resets the streak (2 → 0) and keeps the node alive", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    await parts.proxyManager.markNblDestinationFailure(node.id, "timeout");
    await parts.proxyManager.markNblDestinationFailure(node.id, "timeout");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(2);
    await parts.proxyManager.markNblDestinationSuccess(node.id);
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
    expect(parts.proxies.get(node.id)).not.toBeNull();
    // Two more failures now must NOT delete (streak restarted).
    await parts.proxyManager.markNblDestinationFailure(node.id, "timeout");
    await parts.proxyManager.markNblDestinationFailure(node.id, "timeout");
    expect(parts.proxies.get(node.id)).not.toBeNull();
    expect(parts.proxies.nblFailStreak(node.id)).toBe(2);
  });

  it("marks the node unhealthy so selection skips it (default recordHealth)", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    await parts.proxyManager.markNblDestinationFailure(node.id, "connectivity");
    const health = parts.proxies.health(node.id)!;
    expect(health.ok).toBe(false);
    expect(health.category).toBe("upstream");
    expect(health.error).toBe("connectivity");
  });

  it("is a no-op for unknown node ids (never throws)", async () => {
    parts = makeParts();
    await expect(parts.proxyManager.markNblDestinationFailure("node_missing", "x")).resolves.toBeUndefined();
    await expect(parts.proxyManager.markNblDestinationSuccess("node_missing")).resolves.toBeUndefined();
  });

  it("autoDeleteAfter=0 keeps counting but never deletes", async () => {
    parts = makeParts();
    const pm = makeManager(parts, { autoDeleteAfter: 0 });
    const node = addNode(parts.proxies, parts.vault, "n1");
    for (let i = 0; i < 4; i++) {
      await pm.markNblDestinationFailure(node.id, "connectivity");
    }
    expect(parts.proxies.nblFailStreak(node.id)).toBe(4);
    expect(parts.proxies.get(node.id)).not.toBeNull();
  });
});

describe("proxy node quarantine: what does NOT count", () => {
  it("config validation failure does not increment the streak", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "ws-no-path");
    parts.proxies.update(node.id, {
      config: { ...parts.proxies.getOrThrow(node.id).config, transport: "ws" },
    });
    const hc = await parts.proxyManager.runHealthCheck(node.id, ECHO_DEST);
    expect(hc.ok).toBe(false);
    expect(hc.category).toBe("config");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
  });

  it("tunnel-start (listener) failure does not increment the streak", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    parts.runtime.setScenario(node.id, "down");
    const hc = await parts.proxyManager.runHealthCheck(node.id, ECHO_DEST);
    expect(hc.ok).toBe(false);
    expect(hc.category).toBe("listener");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
  });

  it("egress-echo target failure does not increment the streak", async () => {
    parts = makeParts();
    const pm = makeManager(parts, {
      fetchThrough: async () => ({ ok: false, latencyMs: 40, error: "mock upstream refused" }),
    });
    const node = addNode(parts.proxies, parts.vault, "n1");
    const hc = await pm.runHealthCheck(node.id, ECHO_DEST);
    expect(hc.ok).toBe(false);
    expect(hc.category).toBe("tls");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
  });
});

describe("proxy node quarantine: runHealthCheck wiring for the NBL target", () => {
  it("increments on an NBL destination failure and resets on an NBL success", async () => {
    parts = makeParts();
    const failing = makeManager(parts, {
      allowlist: ["notebooklm.google.com:443"],
      fetchThrough: async () => ({ ok: false, latencyMs: 40, error: "mock destination refused" }),
    });
    const node = addNode(parts.proxies, parts.vault, "n1");

    const bad1 = await failing.runHealthCheck(node.id, NBL_DEST);
    expect(bad1.ok).toBe(false);
    expect(parts.proxies.nblFailStreak(node.id)).toBe(1);
    const bad2 = await failing.runHealthCheck(node.id, NBL_DEST);
    expect(bad2.ok).toBe(false);
    expect(parts.proxies.nblFailStreak(node.id)).toBe(2);
    // Below the threshold: the node survives, but its persisted health keeps
    // the PRECISE check result (not a generic overwrite).
    const health = parts.proxies.health(node.id)!;
    expect(health.ok).toBe(false);
    expect(health.category).toBe("upstream");

    // A successful NBL check resets the streak and proves nbl_access.
    const succeeding = makeManager(parts, {
      allowlist: ["notebooklm.google.com:443"],
      // A 403 "bot check" from Google IS a working route (any HTTP response).
      fetchThrough: async () => ({ ok: true, status: 403, body: "bot check", latencyMs: 10 }),
    });
    const good = await succeeding.runHealthCheck(node.id, NBL_DEST);
    expect(good.ok).toBe(true);
    expect(good.category).toBe("nbl_access");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
  });
});

describe("proxy node quarantine: auto-delete side effects", () => {
  it("sends a notification naming the node", async () => {
    parts = makeParts();
    const notifier = new FakeNotifier();
    const pm = makeManager(parts, { notifier });
    const node = addNode(parts.proxies, parts.vault, "doomed-node");
    for (let i = 0; i < 3; i++) {
      await pm.markNblDestinationFailure(node.id, "connectivity");
    }
    expect(parts.proxies.get(node.id)).toBeNull();
    expect(notifier.sent).toHaveLength(1);
    expect(notifier.sent[0]).toContain("doomed-node");
    expect(notifier.sent[0]).toContain("NotebookLM");
  });

  it("stops the tunnel BEFORE deleting the node", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    const nodeCfg = parts.proxies.getOrThrow(node.id);
    await parts.runtime.startTunnel(nodeCfg, (ref) => parts.vault.get(ref));

    const stopSpy = vi.spyOn(parts.runtime, "stopTunnel");
    const deleteSpy = vi.spyOn(parts.proxies, "delete");
    for (let i = 0; i < 3; i++) {
      await parts.proxyManager.markNblDestinationFailure(node.id, "connectivity");
    }
    expect(parts.proxies.get(node.id)).toBeNull();
    expect(stopSpy).toHaveBeenCalledWith(node.id);
    expect(deleteSpy).toHaveBeenCalledWith(node.id);
    const stopOrder = stopSpy.mock.invocationCallOrder?.[0] ?? -1;
    const deleteOrder = deleteSpy.mock.invocationCallOrder?.[0] ?? -1;
    expect(stopOrder).toBeLessThan(deleteOrder);
  });

  it("does not delete a shared secret while a sibling node still references it", async () => {
    parts = makeParts();
    const a = addNode(parts.proxies, parts.vault, "n1");
    const refA = parts.proxies.getOrThrow(a.id).config.uuidSecretRef;
    // Sibling node referencing the SAME vault secret (same provider key).
    parts.vault.put(refA, parts.vault.get(refA), "vless-uuid");
    const b = addNode(parts.proxies, parts.vault, "n2");
    parts.proxies.update(b.id, {
      config: { ...parts.proxies.getOrThrow(b.id).config, uuidSecretRef: refA },
    });
    for (let i = 0; i < 3; i++) {
      await parts.proxyManager.markNblDestinationFailure(a.id, "connectivity");
    }
    expect(parts.proxies.get(a.id)).toBeNull();
    expect(parts.proxies.get(b.id)).not.toBeNull();
    // The shared secret must survive: the sibling still needs it.
    expect(parts.vault.has(refA)).toBe(true);
  });
});
