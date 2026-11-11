import { afterEach, describe, expect, it } from "vitest";
import { addNode, makeParts, type TestParts } from "./helpers.js";

/**
 * ProxiesRepo NBL-destination streak support (plan: proxy failover + async
 * import, Task 1). The streak is INTERNAL bookkeeping for node quarantine:
 * it is persisted on the proxy_nodes row but must NEVER appear on the
 * shared ProxyNode type (no API/serialization exposure).
 */

let parts: TestParts;

afterEach(() => parts.dispose());

describe("proxy NBL fail streak", () => {
  it("a fresh node has streak 0", () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
  });

  it("incrementNblFailStreak returns 1, 2, 3 on successive calls", () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    expect(parts.proxies.incrementNblFailStreak(node.id)).toBe(1);
    expect(parts.proxies.incrementNblFailStreak(node.id)).toBe(2);
    expect(parts.proxies.incrementNblFailStreak(node.id)).toBe(3);
  });

  it("resetNblFailStreak returns the streak to 0", () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    parts.proxies.incrementNblFailStreak(node.id);
    parts.proxies.incrementNblFailStreak(node.id);
    expect(parts.proxies.nblFailStreak(node.id)).toBe(2);
    parts.proxies.resetNblFailStreak(node.id);
    expect(parts.proxies.nblFailStreak(node.id)).toBe(0);
  });

  it("streak persists across get()/getOrThrow() calls and is not exposed on ProxyNode", () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    parts.proxies.incrementNblFailStreak(node.id);
    parts.proxies.incrementNblFailStreak(node.id);

    const viaGet = parts.proxies.get(node.id)!;
    const viaGetOrThrow = parts.proxies.getOrThrow(node.id);
    expect(viaGet).toMatchObject({ id: node.id, enabled: true });
    expect(viaGetOrThrow).toMatchObject({ id: node.id, enabled: true });
    // The shared ProxyNode type carries no streak field.
    expect("nblFailStreak" in viaGet).toBe(false);
    expect("nbl_fail_streak" in viaGet).toBe(false);
    // ...but the internal accessor still sees the persisted value.
    expect(parts.proxies.nblFailStreak(node.id)).toBe(2);
    expect(parts.proxies.list().map((n) => n.id)).toContain(node.id);
  });

  it("streak accessors are safe for unknown node ids", () => {
    parts = makeParts();
    expect(parts.proxies.nblFailStreak("node_missing")).toBe(0);
    // No throw: unknown ids are no-ops (defensive bookkeeping).
    expect(() => parts.proxies.incrementNblFailStreak("node_missing")).not.toThrow();
    expect(parts.proxies.nblFailStreak("node_missing")).toBe(0);
    expect(() => parts.proxies.resetNblFailStreak("node_missing")).not.toThrow();
  });
});
