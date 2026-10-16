import { mkdirSync } from "node:fs";
import { dataPaths, loadConfig, type AppConfig } from "./config.js";
import { Db } from "./db/db.js";
import { AccountsRepo } from "./domain/accounts.repo.js";
import { JobsRepo } from "./domain/jobs.repo.js";
import { ProxiesRepo } from "./domain/proxies.repo.js";
import { SecretVault } from "./secrets/vault.js";
import { MockProvider } from "./providers/mock-provider.js";
import type { NotebookLMProvider } from "./providers/types.js";
import { MockProxyRuntime, XrayProxyRuntimeStub, type ProxyRuntime } from "./proxy/runtime.js";
import { MockProviderEgress } from "./proxy/egress.js";
import { ProxyManager } from "./proxy/proxy-manager.js";
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
  const proxies = new ProxiesRepo(db);
  const jobs = new JobsRepo(db);

  // Provider: mock by default. The python-worker provider is a separate,
  // approval-gated integration (docs/provider-evaluation.md).
  const provider: NotebookLMProvider =
    config.provider === "python-worker" ? createPythonWorkerProvider() : new MockProvider();

  // Proxy runtime: mock by default; xray is a stub until approved.
  const runtime: ProxyRuntime =
    config.proxyRuntime === "xray" ? new XrayProxyRuntimeStub() : new MockProxyRuntime();

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
    async (_via, _dest) => ({ ok: true, latencyMs: 1 }),
  );

  const runner = new JobRunner({
    jobs,
    accounts,
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
      db.close();
    },
  };
}

/**
 * Placeholder for the approval-gated python worker provider. Building it
 * requires the notebooklm-py dependency + a live-approval step, so it is not
 * constructed by default. Importing this is a hard error until implemented.
 */
function createPythonWorkerProvider(): NotebookLMProvider {
  throw new Error(
    "python-worker provider is not enabled in this build. Set NLO_PROVIDER=mock, " +
      "or complete the gated integration described in docs/provider-evaluation.md.",
  );
}
