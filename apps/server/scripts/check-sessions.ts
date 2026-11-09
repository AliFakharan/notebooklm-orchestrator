/**
 * One-shot LIVE session check — OPERATOR COMMAND (never runs in CI).
 *
 * Run:  npm run check:sessions --workspace @nlo/server
 *
 * Answers "are the pasted Google cookies still live RIGHT NOW?" by running
 * the real, tunnel-routed verify path against every enabled account and
 * printing a status table. It applies the SAME state transitions as the UI
 * verify route (via the shared verify-service), so a green row means the
 * account is AUTHENTICATED and usable.
 *
 * IMPORTANT (honesty):
 *   - This builds the FULL app context (queue starts; it may execute queued
 *     jobs) and the REAL provider (real Google traffic through the tunnel).
 *     It is a manual operator command, not an automated check.
 *   - It does NOT start the background session keeper (startKeeper:false):
 *     a one-shot check verifies directly; a keeper would double-verify and
 *     race this process's own close.
 *   - It exits 0 only if EVERY enabled account verified OK.
 *   - It never prints secrets (tokens, cookies, UUIDs).
 */
import { redactSecrets } from "@nlo/shared";
import { loadConfig, loadDotEnv } from "../src/config.js";
import { createAppContext } from "../src/app-context.js";
import { verifySession } from "../src/auth/verify-service.js";

const PROVIDER = "python-worker";

type Verdict = "OK" | "REJECTED" | "INFRA-ERROR";

interface Row {
  label: string;
  email: string | null;
  state: string;
  verdict: Verdict;
  detail: string;
  latencyMs: number;
}

function pad(s: string, n: number): string {
  const t = s.length >= n ? `${s.slice(0, n - 1)}…` : s;
  return t.padEnd(n);
}

async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  if (config.provider !== PROVIDER) {
    console.log(`check:sessions requires NLO_PROVIDER=python-worker (got "${config.provider}")`);
    process.exit(2);
  }

  const ctx = createAppContext(config, { startKeeper: false });
  const rows: Row[] = [];
  try {
    const accounts = ctx.accounts.list().filter((a) => a.enabled);
    if (accounts.length === 0) {
      console.log("no enabled accounts configured — nothing to check");
      return;
    }
    console.log(`checking ${accounts.length} enabled account(s) against the REAL service...\n`);

    for (const acct of accounts) {
      const before = ctx.sessions.get(acct.id, PROVIDER);
      const t0 = Date.now();
      let verdict: Verdict;
      let detail: string;
      let email: string | null = before?.email ?? null;
      try {
        const r = await verifySession(ctx, acct.id);
        verdict = r.ok ? "OK" : "REJECTED";
        detail = redactSecrets(r.detail ?? (r.ok ? "verified" : "session rejected"));
        email = r.email ?? before?.email ?? null;
      } catch (e) {
        // Hard provider error (tunnel/worker/timeout) — NOT an expiry.
        verdict = "INFRA-ERROR";
        detail = redactSecrets(e instanceof Error ? e.message : String(e));
      }
      const after = ctx.sessions.get(acct.id, PROVIDER);
      rows.push({
        label: acct.label,
        email,
        state: after?.state ?? "NO-ROW",
        verdict,
        detail,
        latencyMs: Date.now() - t0,
      });
    }

    // --- table -------------------------------------------------------------
    console.log(
      pad("ACCOUNT", 32).padEnd(32) +
        pad("STATE", 20) +
        pad("VERDICT", 14) +
        pad("LATENCY", 10) +
        "DETAIL",
    );
    console.log("-".repeat(120));
    for (const r of rows) {
      console.log(
        pad(r.label, 32) +
          pad(r.state, 20) +
          pad(r.verdict, 14) +
          pad(`${r.latencyMs}ms`, 10) +
          r.detail,
      );
    }
    console.log("");

    const allOk = rows.length > 0 && rows.every((r) => r.verdict === "OK");
    const rejected = rows.filter((r) => r.verdict === "REJECTED");
    const infra = rows.filter((r) => r.verdict === "INFRA-ERROR");
    if (allOk) {
      console.log("RESULT: all enabled sessions verified OK — live and usable.");
    } else {
      for (const r of rejected) {
        console.log(
          `RESULT: ${r.label} REJECTED — the service no longer accepts the stored session. Re-login and paste fresh cookies.`,
        );
      }
      for (const r of infra) {
        console.log(
          `RESULT: ${r.label} INFRA-ERROR — could not verify (tunnel/worker/timeout). This is NOT an expiry; check the tunnel and re-run.`,
        );
      }
    }
    process.exitCode = allOk ? 0 : 1;
  } finally {
    await ctx.close();
  }
}

main().catch((e) => {
  console.error(
    `check:sessions harness error: ${redactSecrets(e instanceof Error ? (e.stack ?? String(e)) : String(e))}`,
  );
  process.exit(2);
});
