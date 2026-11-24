import { afterEach, describe, expect, it } from "vitest";
import {
  addAccount,
  addNode,
  createJob,
  makeParts,
  markHealthy,
  markUnhealthy,
  type TestParts,
} from "./helpers.js";

/**
 * Direct-egress mode (NLO_ALLOW_DIRECT_EGRESS=1) — jobs path.
 *
 * Semantics (mirror python-worker-provider.acquireAuthTunnel): direct egress
 * is permitted ONLY when zero enabled proxy nodes exist. If any enabled node
 * exists, the normal fail-closed selectAuto() path applies — a node that is
 * unhealthy still fails the job (there is no direct fallback).
 */

let parts: TestParts;

afterEach(() => parts.dispose());

describe("direct egress (allowDirect, zero proxy nodes)", () => {
  it("succeeds the job with a null tunnel, nodeId null, and no proxy events", async () => {
    parts = makeParts({ allowDirect: true });
    addAccount(parts.accounts, "acct-1");
    // No proxy nodes configured at all.
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
    // The single attempt was recorded without a proxy node.
    const attempts = parts.jobs.attempts(job.id);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]!.nodeId).toBeNull();
    // No proxy selection happened; the direct path is logged instead.
    const events = parts.jobs.events(job.id);
    expect(events.some((e) => e.type === "proxy_selected")).toBe(false);
    expect(events.some((e) => e.type === "proxy_candidate_rejected")).toBe(false);
    expect(events.some((e) => e.type === "proxy_unavailable")).toBe(false);
    expect(events.some((e) => e.type === "direct_egress")).toBe(true);
    // Egress went direct (no tunnel).
    expect(parts.egress.attempts).toHaveLength(1);
    expect(parts.egress.attempts[0]!.viaTunnel).toBe(false);
  });

  it("still fails closed when an enabled node exists but is unhealthy", async () => {
    parts = makeParts({ allowDirect: true });
    addAccount(parts.accounts, "acct-1");
    const node = addNode(parts.proxies, parts.vault, "n1");
    markUnhealthy(parts.proxies, node.id, "down");
    parts.runtime.setScenario(node.id, "down");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("proxy");
    expect(result.errorMessage).toMatch(/fail-closed/i);
    // No provider traffic happened at all.
    expect(parts.egress.attempts).toHaveLength(0);
  });
});

describe("direct egress with a healthy enabled node (selectAuto path intact)", () => {
  it("still routes through the node", async () => {
    parts = makeParts({ allowDirect: true });
    addAccount(parts.accounts, "acct-1");
    const node = addNode(parts.proxies, parts.vault, "n1");
    markHealthy(parts.proxies, node.id);
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
    // The node was selected (attempt recorded with its id).
    expect(parts.jobs.attempts(job.id)[0]!.nodeId).toBe(node.id);
    const events = parts.jobs.events(job.id);
    expect(events.some((e) => e.type === "proxy_selected")).toBe(true);
    expect(parts.egress.attempts.every((a) => a.viaTunnel)).toBe(true);
  });
});

describe("direct egress disabled (allowDirect unset) — fail-closed unchanged", () => {
  it("fails with a proxy error when no node exists", async () => {
    parts = makeParts();
    addAccount(parts.accounts, "acct-1");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("proxy");
    expect(result.errorMessage).toMatch(/fail-closed/i);
    expect(parts.egress.attempts).toHaveLength(0);
  });
});
