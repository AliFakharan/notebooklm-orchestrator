import { afterEach, describe, expect, it, vi } from "vitest";
import type { SelectionInfo } from "../src/proxy/proxy-manager.js";
import { addNode, makeParts, markHealthy, type TestParts } from "./helpers.js";

/**
 * ProxyManager.selectWithFailover (plan: proxy failover + async import,
 * Task 3). A tunnel that passes the staged health check can still fail the
 * heavy NotebookLM client; the caller-plugged `verify` callback is the real
 * proof. Only `connectivity`/`timeout` verdicts trigger failover; any other
 * code throws immediately.
 */

interface Verdict {
  ok: boolean;
  code?: string;
  detail?: string;
}

let parts: TestParts;

afterEach(() => parts.dispose());

function setupThreeNodes() {
  parts = makeParts();
  const n1 = addNode(parts.proxies, parts.vault, "n1", 10);
  const n2 = addNode(parts.proxies, parts.vault, "n2", 20);
  const n3 = addNode(parts.proxies, parts.vault, "n3", 30);
  for (const n of [n1, n2, n3]) markHealthy(parts.proxies, n.id);
  return { n1, n2, n3 };
}

function scriptVerify(verdicts: Verdict[]) {
  const called: string[] = [];
  const verify = async (sel: SelectionInfo): Promise<Verdict> => {
    called.push(sel.node.id);
    const next = verdicts.shift();
    if (!next) throw new Error("verify called more times than scripted");
    return next;
  };
  return { verify, called };
}

describe("selectWithFailover", () => {
  it("verify succeeds on the first node -> returned immediately", async () => {
    const { n1 } = setupThreeNodes();
    const { verify, called } = scriptVerify([{ ok: true }]);
    const sel = await parts.proxyManager.selectWithFailover(null, { verify });
    expect(sel.node.id).toBe(n1.id);
    expect(called).toEqual([n1.id]);
  });

  it("no verify -> behaves like selectAuto (first eligible node)", async () => {
    const { n1 } = setupThreeNodes();
    const sel = await parts.proxyManager.selectWithFailover(null);
    expect(sel.node.id).toBe(n1.id);
  });

  it("connectivity failure on node 1, success on node 2 -> returns node 2", async () => {
    const { n1, n2 } = setupThreeNodes();
    const { verify, called } = scriptVerify([
      { ok: false, code: "connectivity", detail: "verify timed out" },
      { ok: true },
    ]);
    const sel = await parts.proxyManager.selectWithFailover(null, { verify });
    expect(called).toEqual([n1.id, n2.id]);
    expect(sel.node.id).toBe(n2.id);
    // Failed node: tunnel stopped, marked unhealthy, streak bumped.
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(1);
    expect(parts.proxies.health(n1.id)!.ok).toBe(false);
  });

  it("connectivity failure on all 3 nodes -> throws with combined error", async () => {
    const { n1, n2, n3 } = setupThreeNodes();
    const { verify, called } = scriptVerify([
      { ok: false, code: "connectivity", detail: "n1 broken" },
      { ok: false, code: "timeout", detail: "n2 broken" },
      { ok: false, code: "connectivity", detail: "n3 broken" },
    ]);
    let msg = "";
    try {
      await parts.proxyManager.selectWithFailover(null, { verify });
      throw new Error("expected selectWithFailover to throw");
    } catch (e) {
      msg = (e as Error).message;
    }
    expect(msg).toMatch(/proxy failover exhausted/);
    expect(msg).toContain("n1");
    expect(msg).toContain("n2");
    expect(msg).toContain("n3");
    expect(msg).toContain("connectivity");
    expect(called).toEqual([n1.id, n2.id, n3.id]);
    for (const n of [n1, n2, n3]) {
      expect(parts.proxies.nblFailStreak(n.id)).toBe(1);
      expect(parts.proxies.health(n.id)!.ok).toBe(false);
    }
  });

  it("auth failure -> throws immediately, no failover", async () => {
    const { n1, n2 } = setupThreeNodes();
    void n2;
    const { verify, called } = scriptVerify([
      { ok: false, code: "auth", detail: "session rejected" },
      { ok: true }, // must never be consumed
    ]);
    await expect(
      parts.proxyManager.selectWithFailover(null, { verify }),
    ).rejects.toThrow(/non-failover code 'auth'/);
    expect(called).toEqual([n1.id]);
    // The node is innocent: its streak is untouched.
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(0);
  });

  it("connectivity on node 1 then auth on node 2 -> stops at node 2", async () => {
    const { n1, n2, n3 } = setupThreeNodes();
    void n3;
    const { verify, called } = scriptVerify([
      { ok: false, code: "connectivity", detail: "n1 broken" },
      { ok: false, code: "auth", detail: "session rejected" },
    ]);
    await expect(
      parts.proxyManager.selectWithFailover(null, { verify }),
    ).rejects.toThrow(/n2/);
    expect(called).toEqual([n1.id, n2.id]);
    expect(parts.proxies.get(n3.id)).not.toBeNull();
  });

  it("stops the failed node's tunnel BEFORE starting the next node's", async () => {
    const { n1, n2 } = setupThreeNodes();
    const startSpy = vi.spyOn(parts.runtime, "startTunnel");
    const stopSpy = vi.spyOn(parts.runtime, "stopTunnel");
    const { verify } = scriptVerify([
      { ok: false, code: "timeout", detail: "n1 broken" },
      { ok: true },
    ]);
    await parts.proxyManager.selectWithFailover(null, { verify });
    const startCalls = startSpy.mock.calls.map((c) => (c[0] as { id: string }).id);
    expect(startCalls).toContain(n1.id);
    expect(startCalls).toContain(n2.id);
    expect(stopSpy).toHaveBeenCalledWith(n1.id);
    const stopOrder = stopSpy.mock.invocationCallOrder?.[0] ?? -1;
    const startOrder = (id: string) =>
      startSpy.mock.invocationCallOrder?.[startCalls.indexOf(id)] ?? -1;
    expect(stopOrder).toBeGreaterThan(startOrder(n1.id));
    expect(stopOrder).toBeLessThan(startOrder(n2.id));
  });

  it("a node auto-deleted mid-failover is never retried", async () => {
    const { n1, n2 } = setupThreeNodes();
    // n1 already has 2 recorded NBL destination failures from earlier.
    parts.proxies.incrementNblFailStreak(n1.id);
    parts.proxies.incrementNblFailStreak(n1.id);
    const { verify, called } = scriptVerify([
      { ok: false, code: "connectivity", detail: "n1 broken again" },
      { ok: true },
    ]);
    const sel = await parts.proxyManager.selectWithFailover(null, { verify });
    expect(called).toEqual([n1.id, n2.id]);
    expect(sel.node.id).toBe(n2.id);
    // Third consecutive failure auto-deleted n1 (repo + its tunnel).
    expect(parts.proxies.get(n1.id)).toBeNull();
  });

  it("preferred node is tried first when it is eligible", async () => {
    const { n1, n2, n3 } = setupThreeNodes();
    void n2;
    const { verify, called } = scriptVerify([
      { ok: false, code: "connectivity", detail: "n3 broken" },
      { ok: true },
    ]);
    const sel = await parts.proxyManager.selectWithFailover(n3.id, { verify });
    expect(called[0]).toBe(n3.id);
    expect(sel.node.id).toBe(n1.id);
  });
});
