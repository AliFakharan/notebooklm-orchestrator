import { mkdirSync } from "node:fs";
import { dataPaths, loadConfig, type AppConfig } from "./config.js";
import { Db } from "./db/db.js";
import { AccountsRepo } from "./domain/accounts.repo.js";
import { AuthSessionsRepo } from "./domain/auth-sessions.repo.js";
import { JobsRepo } from "./domain/jobs.repo.js";
import { ProxiesRepo } from "./domain/proxies.repo.js";
import { SecretVault } from "./secrets/vault.js";
import { MockProvider } from "./providers/mock-provider.js";
import { PythonWorkerProvider } from "./providers/python-worker/python-worker-provider.js";
import type { NotebookLMProvider } from "./providers/types.js";
import { MockProxyRuntime, createXrayProxyRuntime, type ProxyRuntime } from "./proxy/runtime.js";
import { MockProviderEgress } from "./proxy/egress.js";
import { ProxyManager } from "./proxy/proxy-manager.js";
import { fetchThroughTunnel } from "./proxy/connect-proxy.js";
import { JobRunner } from "./queue/job-runner.js";
import { Queue } from "./queue/queue.js";

/**
 * AppContext: composes all services from configuration.
 * A single instance per process; tests build their own with temp dirs.
 */
export interface AppContext {
  config: AppConfig;
  db: Db;
  vault: SecretVault;
  accounts: AccountsRepo;
  sessions: AuthSessionsRepo;
  proxies: ProxiesRepo;
  jobs: JobsRepo;
  provider: NotebookLMProvider;
  runtime: ProxyRuntime;
  egress: MockProviderEgress;
  proxyManager: ProxyManager;
  runner: JobRunner;
  queue: Queue;
  close(): Promise<void>;
}

export function createAppContext(config: AppConfig = loadConfig()): AppContext {
  const paths = dataPaths(config.dataDir);
  for (const dir of [paths.jobsDir, paths.vaultDir, paths.tempDir]) {
    mkdirSync(dir, { recursive: true });
  }

  const db = Db.open(paths.dbFile);
  const vault = SecretVault.open(db, { keyHex: config.vaultKey, keyFile: paths.vaultKeyFile });
  const accounts = new AccountsRepo(db);
  const sessions = new AuthSessionsRepo(db);
  const proxies = new ProxiesRepo(db);
  const jobs = new JobsRepo(db);

  mkdirSync(paths.sessionsDir, { recursive: true, mode: 0o700 });
  mkdirSync(paths.vendorDir, { recursive: true });

  // Proxy runtime: mock by default; xray when the binary is present/approved.
  // The stub remains as a safe last resort (reports not_configured, fails
  // closed) — it is never a "working" runtime.
  const runtime: ProxyRuntime =
    config.proxyRuntime === "xray"
      ? createXrayProxyRuntime({ vendorDir: paths.vendorDir })
      : new MockProxyRuntime();

  // Egress: the mock egress wires the provider to the mock runtime scenario.
  const mockRuntime = runtime as MockProxyRuntime;
  const egress = new MockProviderEgress(
    async (tunnel, target) => {
      // Simulated upstream through the tunnel.
      void tunnel;
      return { status: 200, body: `mock upstream response for ${target}` };
    },
    (nodeId) => mockRuntime.scenario(nodeId),
  );

  const proxyManager = new ProxyManager(
    proxies,
    runtime,
    config.healthAllowlist,
    // REAL connectivity: every health-check fetch goes out through the node's
    // local tunnel (CONNECT + TLS via https-proxy-agent). There is no direct
    // path: if no tunnel handle is present the check fails closed.
    async (via, dest) => {
      if (!via) {
        return { ok: false, latencyMs: 0, error: "no tunnel available (fail-closed)" };
      }
      const r = await fetchThroughTunnel(via, dest);
      return {
        ok: r.ok,
        status: r.status,
        body: r.body,
        latencyMs: r.latencyMs,
        error: r.error,
      };
    },
    vault,
    { log: (msg) => console.log(`[nlo:proxy] ${msg}`) },
  );

  // Provider selection is EXPLICIT and observable: config.provider decides.
  // There is no silent fallback: "python-worker" must actually start.
  // The worker gets the proxy manager so auth ops (login/verify) route
  // through the same verified tunnels as jobs (fail-closed).
  const provider: NotebookLMProvider =
    config.provider === "python-worker"
      ? new PythonWorkerProvider({
          sessionDir: paths.sessionsDir,
          dataDir: config.dataDir,
          pythonBin: config.pythonBin,
          loginBrowser: config.loginBrowser,
          jobTimeoutMs: config.jobTimeoutMs,
          allowDirect: config.allowDirectEgress,
          proxyManager,
          proxiesRepo: {
            countEnabled: () => proxies.list().filter((n) => n.enabled).length,
            listEnabled: () =>
              proxies
                .list()
                .filter((n) => n.enabled)
                .map((n) => ({ id: n.id })),
            health: (nodeId) => proxies.health(nodeId),
          },
          log: (msg) => console.log(`[nlo:worker] ${msg}`),
        })
      : new MockProvider();

  // The sessions gate applies to the REAL provider only: a verified
  // auth-session row is the sole evidence of a usable credential there.
  // The mock provider simulates accounts and has no session records, so
  // offline mock flows keep their historical behavior.
  const runner = new JobRunner({
    jobs,
    accounts,
    sessions: config.provider === "python-worker" ? sessions : undefined,
    proxies,
    provider,
    proxyManager,
    runtime,
    vault,
    egress,
    jobsDir: paths.jobsDir,
    log: (msg) => {
      // Structured-ish, redaction is applied at call sites.
      console.log(`[nlo] ${msg}`);
    },
  });

  const queue = new Queue(runner, 500, (msg) => console.log(`[nlo:queue] ${msg}`));

  // On boot, recover in-flight jobs from a previous run.
  const recovered = jobs.recoverInFlight();
  if (recovered.length > 0) {
    console.log(`[nlo] recovered ${recovered.length} in-flight job(s) to QUEUED`);
  }

  queue.start();

  return {
    config,
    db,
    vault,
    accounts,
    sessions,
    proxies,
    jobs,
    provider,
    runtime,
    egress,
    proxyManager,
    runner,
    queue,
    close: async () => {
      await queue.stop();
      (provider as { dispose?: () => void }).dispose?.();
      await (runtime as { close?: () => Promise<void> }).close?.();
      db.close();
    },
  };
}
