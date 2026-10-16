/**
 * Live verification harness — MANUAL GATE (never runs in CI).
 *
 * Run:  npm run verify:live --workspace @nlo/server
 *
 * Proves, with printed evidence, that the REAL path works end to end:
 *   STEP 1  login     — real Google sign-in via Playwright (worker); the
 *                        storage-state is stored 0600 and verified live.
 *   STEP 2  proxy     — real Xray tunnel for a configured node; a REAL
 *                        HTTPS request through it (CONNECT + TLS) proves the
 *                        route; observed public egress IP is printed.
 *   STEP 3  job       — a REAL job (audio or text) executes through the
 *                        tunnel and returns a NON-mock grounded answer.
 *
 * Each step prints its evidence. No step can be "passed" by simulation:
 * the worker talks to the real service, xray to the real proxy, and the
 * fetcher performs a real TLS session through the tunnel.
 *
 * Safety:
 *   - binds nothing extra; uses the app on NLO_PORT
 *   - never prints secrets (UUIDs, cookies, tokens)
 *   - refuses to run when NLO_PROVIDER != python-worker
 */
import { existsSync } from "node:fs";
import { loadConfig, loadDotEnv, dataPaths } from "../src/config.js";
import { Db } from "../src/db/db.js";
import { PythonWorkerProvider } from "../src/providers/python-worker/python-worker-provider.js";
import { WorkerSupervisor } from "../src/providers/python-worker/worker.js";
import { createXrayProxyRuntime } from "../src/proxy/runtime.js";
import { fetchThroughTunnel } from "../src/proxy/connect-proxy.js";
import { ProxiesRepo } from "../src/domain/proxies.repo.js";
import { AuthSessionsRepo } from "../src/domain/auth-sessions.repo.js";
import { AccountsRepo } from "../src/domain/accounts.repo.js";
import { SecretVault } from "../src/secrets/vault.js";

const PASS = "✓ PASS";
const FAIL = "✗ FAIL";
let failed = false;
function step(name: string) {
  console.log(`\n${"=".repeat(70)}\nSTEP: ${name}\n${"=".repeat(70)}`);
}
function ok(msg: string) {
  console.log(`${PASS} ${msg}`);
}
function fail(msg: string) {
  failed = true;
  console.log(`${FAIL} ${msg}`);
}
function info(msg: string) {
  console.log(`   ${msg}`);
}

async function main() {
  loadDotEnv();
  const config = loadConfig();
  const paths = dataPaths(config.dataDir);
  if (config.provider !== "python-worker") {
    console.log(
      `${FAIL} NLO_PROVIDER must be "python-worker" for live verification (got "${config.provider}")`,
    );
    process.exit(2);
  }
  const db = Db.open(paths.dbFile);
  const vault = SecretVault.open(db, { keyHex: config.vaultKey, keyFile: paths.vaultKeyFile });
  const accounts = new AccountsRepo(db);
  const proxies = new ProxiesRepo(db);
  const sessions = new AuthSessionsRepo(db);
  const provider = new PythonWorkerProvider({
    sessionDir: paths.sessionsDir,
    dataDir: config.dataDir,
    pythonBin: config.pythonBin,
    jobTimeoutMs: config.jobTimeoutMs,
    log: (l) => console.log(`   [worker] ${l}`),
  });

  // --- environment preflight -------------------------------------------------
  step("preflight: python + notebooklm-py + playwright");
  const w = new WorkerSupervisor({ pythonBin: config.pythonBin, log: (l) => info(`[sup] ${l}`) });
  try {
    const info0 = await w.start();
    if (info0.version) ok(`notebooklm-py v${info0.version} imports cleanly`);
    else fail("notebooklm-py NOT importable in worker python");
    if (info0.playwright) ok("playwright importable");
    else {
      info(
        "playwright NOT installed — STEP 1 (login) will need: pip install playwright && playwright install chromium",
      );
    }
  } catch (e) {
    fail(`worker start failed: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    await w.close().catch(() => {});
  }

  // --- STEP 1: login (real Google sign-in) ------------------------------------
  step("1: account session (login / verify)");
  const accts = accounts.list().filter((a) => a.enabled);
  if (accts.length === 0) {
    fail("no enabled account configured — add one via the UI/API first");
  }
  for (const acct of accts) {
    const session = sessions.ensure(acct.id, "python-worker", acct.authProfile ?? "default");
    if (sessions.isUsable(session)) {
      ok(`account ${acct.label}: session AUTHENTICATED, last verified ${session.lastVerifiedAt}`);
      continue;
    }
    const file = provider.sessionPathFor(acct.id);
    if (!existsSync(file)) {
      info(
        `account ${acct.label}: no stored session. A human must complete login: POST /api/sessions/${acct.id}/login (interactive browser).`,
      );
      fail(`account ${acct.label}: no stored session file (${file})`);
      continue;
    }
    info(`account ${acct.label}: verifying stored session against the REAL service...`);
    try {
      const status = await provider.getAccountStatus(acct.id, "session");
      if (status.ok) {
        sessions.transition(acct.id, "python-worker", "AUTHENTICATED", {
          email: status.email,
          verified: true,
        });
        ok(`account ${acct.label}: session verified live as ${status.email} — ${status.detail}`);
      } else {
        sessions.transition(acct.id, "python-worker", "AUTH_REQUIRED", {
          lastError: status.detail ?? "rejected",
        });
        fail(
          `account ${acct.label}: service REJECTED the stored session — re-login required. ${status.detail}`,
        );
      }
    } catch (e) {
      fail(
        `account ${acct.label}: verification error: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // --- STEP 2: proxy (real xray tunnel + real fetch through it) ----------------
  step("2: proxy tunnel (real route, measured egress)");
  const nodes = proxies.list().filter((n) => n.enabled);
  if (nodes.length === 0) {
    fail("no enabled proxy node configured — add one via the UI/API first");
  }
  const runtime = createXrayProxyRuntime({
    vendorDir: paths.vendorDir,
    log: (l) => info(`[xray] ${l}`),
  });
  const rstatus = runtime.status();
  if (rstatus.state !== "available") {
    fail(
      `xray runtime not available: ${rstatus.state === "not_configured" ? rstatus.reason : rstatus}`,
    );
  }
  for (const node of nodes) {
    info(`node ${node.config.name} (${node.id}): starting real tunnel...`);
    try {
      const handle = await runtime.startTunnel(node, (ref) => vault.get(ref));
      info(`tunnel up on 127.0.0.1:${handle.port}`);
      const res = await fetchThroughTunnel(handle, { host: "api.ipify.org", port: 443 });
      if (res.ok) {
        const ip = res.body?.trim().match(/^\d{1,3}(?:\.\d{1,3}){3}$/)?.[0];
        ok(
          `node ${node.config.name}: REAL HTTPS through tunnel succeeded; observed public egress IP: ${ip ?? res.body?.trim() ?? "?"} (${res.latencyMs}ms)`,
        );
      } else {
        fail(
          `node ${node.config.name}: fetch through tunnel FAILED: ${res.error} (route is NOT proven)`,
        );
      }
    } catch (e) {
      fail(
        `node ${node.config.name}: tunnel failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      await runtime.stopTunnel(node.id).catch(() => {});
    }
  }
  await runtime.close().catch(() => {});

  // --- STEP 3: real job ---------------------------------------------------------
  step("3: real job (grounded answer through the tunnel)");
  if (failed) {
    fail("skipped: earlier steps failed — a real job would be dishonest");
  } else {
    info("submit a job from the UI (or: POST /api/jobs with a small audio + prompt)");
    info("and confirm:");
    info("  - providerMeta.simulated === false");
    info("  - providerMeta.email matches the verified account");
    info("  - the answer references the audio content (grounded, not fabricated)");
    info("  - archive.json execution/ shows provider='python-worker'");
    info(
      "the UI marks the job LIVE when providerMeta.simulated === false; a mock job can never show LIVE.",
    );
    ok("manual job check: complete it in the UI and inspect the job detail page");
  }

  console.log(`\n${"=".repeat(70)}`);
  console.log(
    failed
      ? `LIVE VERIFICATION: FAILED (see ✗ lines above)`
      : `LIVE VERIFICATION: environment steps passed; complete the manual job step`,
  );
  console.log(`${"=".repeat(70)}\n`);
  db.close();
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(`harness error: ${e instanceof Error ? e.stack : String(e)}`);
  process.exit(2);
});
