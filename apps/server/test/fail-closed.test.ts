import { afterEach, describe, expect, it } from "vitest";
import { SsrfBlockedError } from "@nlo/shared";
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
 * Fail-closed egress tests (docs/proxy-design.md §6).
 *
 * Core invariant asserted in every scenario: provider traffic ONLY ever goes
 * through an approved tunnel. The mock egress records every attempt; a
 * `viaTunnel: false` attempt means a direct connection happened, which must
 * NEVER occur.
 */

let parts: TestParts;

afterEach(() => parts.dispose());

function noDirectEgress(): void {
  const direct = parts.egress.attempts.filter((a) => !a.viaTunnel);
  expect(direct, "no direct (tunnel-less) egress may ever be attempted").toHaveLength(0);
}

function setupWithNode() {
  parts = makeParts();
  addAccount(parts.accounts, "acct-1");
  const node = addNode(parts.proxies, parts.vault, "n1");
  markHealthy(parts.proxies, node.id);
  return node;
}

describe("fail-closed egress (scenario 1): no enabled proxy node", () => {
  it("fails the job with a clear reason and performs no egress at all", async () => {
    parts = makeParts();
    addAccount(parts.accounts, "acct-1");
    // No proxy nodes configured at all.
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("proxy");
    expect(result.errorMessage).toMatch(/fail-closed/i);
    expect(result.errorMessage).toMatch(/no enabled proxy node/i);
    // No egress of any kind (not even a blocked direct attempt).
    expect(parts.egress.attempts).toHaveLength(0);
    noDirectEgress();
  });
});

describe("fail-closed egress (scenario 2): tunnel down", () => {
  it("fails the job before any provider traffic, no direct fallback", async () => {
    const node = setupWithNode();
    parts.runtime.setScenario(node.id, "down");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("proxy");
    expect(parts.egress.attempts).toHaveLength(0);
    noDirectEgress();
  });
});

describe("fail-closed egress (scenario 3): invalid node config", () => {
  it("rejects ws transport without path (no network involved)", () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "ws-no-path");
    const bad = parts.proxies.update(node.id, {
      config: { ...parts.proxies.getOrThrow(node.id).config, transport: "ws" },
    });
    const verdict = parts.proxyManager.validateConfig(bad);
    expect(verdict.valid).toBe(false);
    expect(verdict.issues.join(" ")).toMatch(/ws transport requires path/);
  });
});

describe("fail-closed egress (scenario 4): runtime crash mid-job", () => {
  it("retries via the tunnel, exhausts attempts, and never dials directly", async () => {
    const node = setupWithNode();
    parts.runtime.setScenario(node.id, "crash");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    // Every egress attempt went through the tunnel handle.
    expect(parts.egress.attempts.length).toBeGreaterThan(0);
    expect(parts.egress.attempts.every((a) => a.viaTunnel)).toBe(true);
    expect(parts.egress.attempts.every((a) => a.ok === false)).toBe(true);
    noDirectEgress();
    // The job used its bounded retry budget (attempts recorded).
    const attempts = parts.jobs.attempts(job.id);
    expect(attempts.length).toBeGreaterThanOrEqual(2);
  });
});

describe("fail-closed egress (scenario 5): DNS failure via tunnel", () => {
  it("classifies connectivity, retries, then fails — still no direct dial", async () => {
    const node = setupWithNode();
    parts.runtime.setScenario(node.id, "dns_fail");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("connectivity");
    expect(parts.egress.attempts.every((a) => a.viaTunnel)).toBe(true);
    noDirectEgress();
  });
});

describe("fail-closed egress (scenario 6): upstream timeout via tunnel", () => {
  it("schedules backoff retries (events recorded) and eventually fails", async () => {
    const node = setupWithNode();
    parts.runtime.setScenario(node.id, "timeout");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    const events = parts.jobs.events(job.id);
    expect(events.some((e) => e.type === "retry_scheduled")).toBe(true);
    expect(parts.egress.attempts.every((a) => a.viaTunnel)).toBe(true);
    noDirectEgress();
  });
});

describe("fail-closed egress (scenario 7): wrong egress IP on health check", () => {
  it("marks the node unhealthy when egress IP mismatches the expectation", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    // Expect a specific egress IP; the mock reports 198.51.100.7 on "up".
    parts.runtime.setExpectedEgressIp(node.id, "203.0.113.99");
    const res = await parts.proxyManager.runHealthCheck(node.id, {
      host: "93.184.216.34",
      port: 443,
    });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/egress IP mismatch/);
    const health = parts.proxies.health(node.id);
    expect(health?.ok).toBe(false);
  });

  it("passes when the egress IP matches, and select() falls back to the healthy node", async () => {
    parts = makeParts();
    const n1 = addNode(parts.proxies, parts.vault, "n1", 10);
    addNode(parts.proxies, parts.vault, "n2", 20);
    parts.runtime.setExpectedEgressIp(n1.id, "198.51.100.7"); // matches mock
    const res1 = await parts.proxyManager.runHealthCheck(n1.id, {
      host: "93.184.216.34",
      port: 443,
    });
    expect(res1.ok).toBe(true);
    // n2 has no successful health check yet -> n1 is the only healthy node.
    const sel = await parts.proxyManager.select(null);
    expect(sel.node.id).toBe(n1.id);
  });
});

describe("fail-closed egress (scenario 8): fallback node down", () => {
  it("select() prefers the healthy fallback node", async () => {
    parts = makeParts();
    const n1 = addNode(parts.proxies, parts.vault, "n1", 10);
    const n2 = addNode(parts.proxies, parts.vault, "n2", 20);
    markHealthy(parts.proxies, n1.id);
    markHealthy(parts.proxies, n2.id);
    markUnhealthy(parts.proxies, n1.id, "tunnel down");
    const sel = await parts.proxyManager.select(null);
    expect(sel.node.id).toBe(n2.id); // fell back to n2
  });

  it("fails the job when ALL nodes are unhealthy", async () => {
    parts = makeParts();
    addAccount(parts.accounts, "acct-1");
    const n1 = addNode(parts.proxies, parts.vault, "n1");
    const n2 = addNode(parts.proxies, parts.vault, "n2", 20);
    markHealthy(parts.proxies, n1.id);
    markHealthy(parts.proxies, n2.id);
    markUnhealthy(parts.proxies, n1.id, "down");
    markUnhealthy(parts.proxies, n2.id, "down");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("proxy");
    expect(result.errorMessage).toMatch(/fail-closed/i);
    noDirectEgress();
  });
});

describe("fail-closed egress (scenario 9): ambiguous completion", () => {
  it("routes to NEEDS_ATTENTION without auto-retry", async () => {
    parts = makeParts();
    const acct = addAccount(parts.accounts, "acct-1");
    const node = addNode(parts.proxies, parts.vault, "n1");
    markHealthy(parts.proxies, node.id);
    parts.provider.setScenario(acct.id, "ambiguous");
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("NEEDS_ATTENTION");
    expect(result.errorClass).toBe("ambiguous");
    // Exactly one attempt: ambiguous is NEVER auto-retried.
    expect(parts.jobs.attempts(job.id)).toHaveLength(1);
  });

  it("can be re-queued by an operator after reconciliation", async () => {
    parts = makeParts();
    const acct = addAccount(parts.accounts, "acct-1");
    const node = addNode(parts.proxies, parts.vault, "n1");
    markHealthy(parts.proxies, node.id);
    parts.provider.setScenario(acct.id, "ambiguous");
    const job = createJob(parts.jobs);
    await parts.runner.run(job.id);
    expect(parts.jobs.get(job.id)!.status).toBe("NEEDS_ATTENTION");
    parts.jobs.setStatus(job.id, "QUEUED"); // operator re-queue
    parts.provider.setScenario(acct.id, "ok"); // issue resolved
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
  });
});

describe("restart recovery (scenario 10)", () => {
  it("resets in-flight jobs to QUEUED on application restart", () => {
    parts = makeParts();
    const job = createJob(parts.jobs);
    // Simulate a crash mid-run by forcing an in-flight state.
    parts.db.raw.prepare("UPDATE jobs SET status = 'RUNNING' WHERE id = ?").run(job.id);
    expect(parts.jobs.get(job.id)!.status).toBe("RUNNING");
    const recovered = parts.jobs.recoverInFlight();
    expect(recovered).toContain(job.id);
    expect(parts.jobs.get(job.id)!.status).toBe("QUEUED");
    const events = parts.jobs.events(job.id);
    expect(events.some((e) => e.type === "restart_recover")).toBe(true);
  });
});

describe("SSRF guard on health checks", () => {
  it("blocks non-allowlisted destinations before any dial", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    await expect(
      parts.proxyManager.runHealthCheck(node.id, { host: "127.0.0.1", port: 443 }),
    ).rejects.toThrow(SsrfBlockedError);
  });

  it("blocks private-range destinations even if DNS resolves them", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    await expect(
      parts.proxyManager.runHealthCheck(node.id, { host: "10.0.0.5", port: 443 }),
    ).rejects.toThrow(SsrfBlockedError);
  });
});

describe("no eligible account", () => {
  it("fails with an auth-class error when no account is available", async () => {
    parts = makeParts();
    const node = addNode(parts.proxies, parts.vault, "n1");
    markHealthy(parts.proxies, node.id);
    const job = createJob(parts.jobs);
    const result = await parts.runner.run(job.id);
    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("auth");
    noDirectEgress();
  });
});
