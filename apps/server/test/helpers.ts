import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig, dataPaths } from "../src/config.js";
import { Db } from "../src/db/db.js";
import { AccountsRepo } from "../src/domain/accounts.repo.js";
import { JobsRepo } from "../src/domain/jobs.repo.js";
import { ProxiesRepo } from "../src/domain/proxies.repo.js";
import { SecretVault } from "../src/secrets/vault.js";
import { MockProvider } from "../src/providers/mock-provider.js";
import { MockProxyRuntime } from "../src/proxy/runtime.js";
import { MockProviderEgress } from "../src/proxy/egress.js";
import { ProxyManager } from "../src/proxy/proxy-manager.js";
import { JobRunner } from "../src/queue/job-runner.js";
import type { Job } from "@nlo/shared";

export interface TestParts {
  dir: string;
  db: Db;
  vault: SecretVault;
  accounts: AccountsRepo;
  proxies: ProxiesRepo;
  jobs: JobsRepo;
  runtime: MockProxyRuntime;
  egress: MockProviderEgress;
  proxyManager: ProxyManager;
  provider: MockProvider;
  runner: JobRunner;
  jobsDir: string;
  dispose(): void;
}

const VAULT_KEY = "ab".repeat(32);

/**
 * Build an isolated in-memory test stack (temp dir, no queue, no network).
 * The egress dial is a stub; the runtime is the deterministic mock.
 */
export function makeParts(): TestParts {
  const dir = mkdtempSync(path.join(tmpdir(), "nlo-test-"));
  const jobsDir = path.join(dir, "jobs");
  const db = Db.open(path.join(dir, "test.sqlite"));
  const vault = SecretVault.open(db, { keyHex: VAULT_KEY, keyFile: path.join(dir, "vault.key") });
  const accounts = new AccountsRepo(db);
  const proxies = new ProxiesRepo(db);
  const jobs = new JobsRepo(db);
  const runtime = new MockProxyRuntime();
  const egress = new MockProviderEgress(
    async (_tunnel, target) => ({ status: 200, body: `mock upstream response for ${target}` }),
    (nodeId) => runtime.scenario(nodeId),
  );
  const proxyManager = new ProxyManager(
    proxies,
    runtime,
    // IP-literal allowlist entry: deterministic, no DNS resolution needed.
    ["93.184.216.34:443"],
    async () => ({ ok: true, latencyMs: 1 }),
    vault,
    {
      // Self-heal re-check target must match the allowlist (no DNS in tests).
      selfHealTarget: { host: "93.184.216.34", port: 443 },
    },
  );
  const provider = new MockProvider();
  const runner = new JobRunner({
    jobs,
    accounts,
    proxies,
    provider,
    proxyManager,
    runtime,
    vault,
    egress,
    jobsDir,
    log: () => {},
    // Instant backoff for fast, deterministic tests.
    sleep: () => Promise.resolve(),
    rng: () => 0,
  });

  return {
    dir,
    db,
    vault,
    accounts,
    proxies,
    jobs,
    runtime,
    egress,
    proxyManager,
    provider,
    runner,
    jobsDir,
    dispose: () => {
      provider.dispose();
      db.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function addAccount(accounts: AccountsRepo, label: string): { id: string } {
  const a = accounts.create({ label, displayEmail: `${label}@example.com` });
  accounts.update(a.id, { status: "ACTIVE" });
  return { id: a.id };
}

export function addNode(
  proxies: ProxiesRepo,
  vault: SecretVault,
  name: string,
  priority = 100,
): { id: string } {
  const uuid = randomUUID();
  const ref = `vless-uuid:${uuid}`;
  vault.put(ref, uuid, "vless-uuid");
  const node = proxies.create(
    {
      name,
      server: "203.0.113.10",
      port: 443,
      uuidSecretRef: ref,
      transport: "tcp",
      security: "none",
      extra: {},
    },
    { priority },
  );
  return { id: node.id };
}

export function markHealthy(proxies: ProxiesRepo, nodeId: string): void {
  proxies.setHealth(
    {
      lastCheckedAt: new Date().toISOString(),
      ok: true,
      egressIp: "198.51.100.7",
      latencyMs: 5,
      error: null,
    },
    nodeId,
  );
}

/** A previously-healthy result aged past the 10-minute freshness TTL.
 *  (setHealth() stamps db.now() on insert, so age the row directly.) */
export function markStaleHealthy(proxies: ProxiesRepo, nodeId: string): void {
  markHealthy(proxies, nodeId);
  const db = (
    proxies as unknown as { db: { raw: { prepare(s: string): { run(...a: unknown[]): void } } } }
  ).db;
  db.raw
    .prepare("UPDATE proxy_health SET last_checked_at = ? WHERE node_id = ?")
    .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), nodeId);
}

export function markUnhealthy(proxies: ProxiesRepo, nodeId: string, error = "failed"): void {
  proxies.setHealth(
    { lastCheckedAt: new Date().toISOString(), ok: false, egressIp: null, latencyMs: null, error },
    nodeId,
  );
}

export function createJob(
  jobs: JobsRepo,
  prompt = "test prompt",
  extra: { preferredNodeId?: string | null; preferredAccountId?: string | null } = {},
): Job {
  return jobs.create({
    input: {
      prompt,
      audio: { originalName: "", mediaType: "", size: 0, sha256: "", providerConfirmed: false },
      preferredAccountId: extra.preferredAccountId ?? null,
      preferredNodeId: extra.preferredNodeId ?? null,
    },
    configSnapshot: { provider: "mock" },
  });
}

/** Build a full AppContext (with queue) on a temp data dir — for API tests. */
export async function makeAppContext(
  env: Record<string, string> = {},
): Promise<import("../src/app-context.js").AppContext> {
  const { createAppContext } = await import("../src/app-context.js");
  const dir = mkdtempSync(path.join(tmpdir(), "nlo-app-"));
  const config = loadConfig({
    NLO_DATA_DIR: dir,
    NLO_PORT: "0",
    ...env,
  });
  const ctx = createAppContext(config);
  // HTTP route tests exercise the API layer only; background job execution
  // (queue) is covered by dedicated runner/queue tests. Stop it so a job
  // created via POST /api/jobs stays in CREATED and does not run mid-test.
  void ctx.queue.stop();
  return {
    ...ctx,
    close: async () => {
      await ctx.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export const dataPathsFor = (dataDir: string) => dataPaths(dataDir);
