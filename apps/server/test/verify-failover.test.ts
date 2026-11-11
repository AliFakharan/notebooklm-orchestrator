import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PythonWorkerProvider } from "../src/providers/python-worker/python-worker-provider.js";
import { ProviderFailure } from "../src/providers/types.js";
import { addNode, makeParts, markHealthy, type TestParts } from "./helpers.js";

/**
 * Verify failover in PythonWorkerProvider (plan: proxy failover + async
 * import, Task 4). The fake worker (test/fake-worker.mjs, spawned via
 * `node`) scripts a per-attempt outcome; the attempt counter is persisted in
 * a state file because every verify attempt spawns a fresh worker process.
 *
 * Failover rules under test:
 *  - `connectivity` / `timeout` -> mark the node (streak + unhealthy +
 *    tunnel stop + auto-delete at threshold), try the next node (cap 3)
 *  - `auth` -> the node worked, the session is bad: soft failure, no failover
 *  - any other code -> throw immediately, no failover
 *  - success -> streak reset on the winning node
 */

const FAKE_WORKER = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url));
const ACCOUNT = "acct1";

let parts: TestParts;
let sessionDir: string;
let stateFile: string;
let provider: PythonWorkerProvider;

function setWorkerScript(script: string[]): void {
  process.env.FAKE_WORKER_SCRIPT = JSON.stringify(script);
  process.env.FAKE_WORKER_STATE_FILE = stateFile;
}

function workerAttempts(): number {
  return Number(JSON.parse(readFileSync(stateFile, "utf8")).count ?? 0);
}

function makeProvider(): PythonWorkerProvider {
  provider = new PythonWorkerProvider({
    sessionDir,
    dataDir: parts.dir,
    pythonBin: process.execPath,
    workerPath: FAKE_WORKER,
    allowDirect: false,
    proxyManager: parts.proxyManager,
    proxiesRepo: {
      countEnabled: () => parts.proxies.list().filter((n) => n.enabled).length,
      listEnabled: () => parts.proxies.list().filter((n) => n.enabled).map((n) => ({ id: n.id })),
      health: (nodeId) => parts.proxies.health(nodeId),
    },
    log: () => {},
  });
  return provider;
}

function setupThreeNodes() {
  const n1 = addNode(parts.proxies, parts.vault, "n1", 10);
  const n2 = addNode(parts.proxies, parts.vault, "n2", 20);
  const n3 = addNode(parts.proxies, parts.vault, "n3", 30);
  for (const n of [n1, n2, n3]) markHealthy(parts.proxies, n.id);
  return { n1, n2, n3 };
}

async function setup(script: string[]) {
  parts = makeParts();
  sessionDir = path.join(parts.dir, "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(sessionDir, `nlo-${ACCOUNT}.json`), JSON.stringify({ cookies: [] }));
  stateFile = path.join(parts.dir, "worker-state.json");
  setWorkerScript(script);
  const nodes = setupThreeNodes();
  makeProvider();
  return nodes;
}

afterEach(() => {
  delete process.env.FAKE_WORKER_SCRIPT;
  delete process.env.FAKE_WORKER_STATE_FILE;
  delete process.env.FAKE_WORKER_DELAY_MS;
  rmSync(sessionDir, { recursive: true, force: true });
  parts.dispose();
});

describe("verify failover (proxy route)", () => {
  it("first node verify succeeds -> ok, no failover, no streak change", async () => {
    const { n1, n2, n3 } = await setup(["ok"]);
    const status = await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
    expect(status.ok).toBe(true);
    expect(status.email).toBe("fake@example.com");
    expect(workerAttempts()).toBe(1);
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(0);
    expect(parts.proxies.nblFailStreak(n2.id)).toBe(0);
    expect(parts.proxies.nblFailStreak(n3.id)).toBe(0);
  });

  it("connectivity on node 1, success on node 2 -> returns ok on node 2", async () => {
    const { n1, n2 } = await setup(["connectivity", "ok"]);
    const stopSpy = vi.spyOn(parts.runtime, "stopTunnel");
    const status = await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
    expect(status.ok).toBe(true);
    expect(workerAttempts()).toBe(2);
    // Node 1: quarantine accounting (streak, unhealthy, tunnel stopped).
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(1);
    expect(parts.proxies.health(n1.id)!.ok).toBe(false);
    expect(stopSpy).toHaveBeenCalledWith(n1.id);
    // Node 2: the winner keeps a clean streak.
    expect(parts.proxies.nblFailStreak(n2.id)).toBe(0);
  });

  it("timeout also triggers failover (like connectivity)", async () => {
    const { n1, n2 } = await setup(["timeout", "ok"]);
    const status = await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
    expect(status.ok).toBe(true);
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(1);
    expect(parts.proxies.nblFailStreak(n2.id)).toBe(0);
  });

  it("all 3 nodes fail with connectivity -> ProviderFailure(connectivity) listing all", async () => {
    const { n1, n2, n3 } = await setup(["connectivity", "connectivity", "connectivity"]);
    let failure: ProviderFailure | null = null;
    try {
      await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
      throw new Error("expected getAccountStatus to throw");
    } catch (e) {
      failure = e as ProviderFailure;
    }
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure!.info.failureClass).toBe("connectivity");
    expect(failure!.message).toContain("n1");
    expect(failure!.message).toContain("n2");
    expect(failure!.message).toContain("n3");
    expect(workerAttempts()).toBe(3);
    for (const n of [n1, n2, n3]) {
      expect(parts.proxies.nblFailStreak(n.id)).toBe(1);
    }
  });

  it("auth failure -> soft failure immediately (no failover, node proven fine)", async () => {
    const { n1 } = await setup(["auth"]);
    const status = await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/session rejected/);
    // Exactly one worker verify ran (node 1 only).
    expect(workerAttempts()).toBe(1);
    // The route worked: no failure streak on the node.
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(0);
  });

  it("connectivity on node 1 then auth on node 2 -> soft failure at node 2", async () => {
    const { n1, n2 } = await setup(["connectivity", "auth"]);
    const status = await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
    expect(status.ok).toBe(false);
    expect(status.detail).toMatch(/session rejected/);
    expect(workerAttempts()).toBe(2);
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(1);
    expect(parts.proxies.nblFailStreak(n2.id)).toBe(0);
  });

  it("rate_limit -> throws immediately (no failover, no streak)", async () => {
    const { n1 } = await setup(["rate_limit"]);
    let failure: ProviderFailure | null = null;
    try {
      await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
      throw new Error("expected getAccountStatus to throw");
    } catch (e) {
      failure = e as ProviderFailure;
    }
    expect(failure).toBeInstanceOf(ProviderFailure);
    expect(failure!.info.failureClass).toBe("rate_limit");
    expect(workerAttempts()).toBe(1);
    expect(parts.proxies.nblFailStreak(n1.id)).toBe(0);
  });

  it("a node auto-deleted mid-failover is never retried", async () => {
    const { n1 } = await setup(["connectivity", "ok"]);
    // n1 already carries 2 consecutive NBL destination failures.
    parts.proxies.incrementNblFailStreak(n1.id);
    parts.proxies.incrementNblFailStreak(n1.id);
    const status = await provider.getAccountStatus(ACCOUNT, `session:${ACCOUNT}`);
    expect(status.ok).toBe(true);
    expect(workerAttempts()).toBe(2);
    // Third consecutive failure: n1 auto-deleted, then n2 was used.
    expect(parts.proxies.get(n1.id)).toBeNull();
  });
});
