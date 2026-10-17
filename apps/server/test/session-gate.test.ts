import { afterEach, describe, expect, it } from "vitest";
import {
  makeParts,
  addAccount,
  addNode,
  markHealthy,
  createJob,
  type TestParts,
} from "./helpers.js";
import { AuthSessionsRepo } from "../src/domain/auth-sessions.repo.js";
import { JobRunner } from "../src/queue/job-runner.js";

/**
 * Session-gated account selection (real provider rule): a DB account row
 * alone is NOT evidence of a usable credential. When the runner is wired
 * with the auth-sessions repo, an account is selectable only if it holds an
 * AUTHENTICATED session verified within the TTL.
 *
 * Invariants under test:
 *  - no verified session  -> job fails with errorClass "auth"
 *  - verified session     -> job runs to SUCCEEDED on that account
 *  - strict preferred account: a requested account without a usable session
 *    fails the job instead of silently switching accounts
 *  - default account is preferred over older-succeeded accounts
 */

let parts: TestParts;
let sessions: AuthSessionsRepo;
let withGate: JobRunner;

afterEach(() => parts.dispose());

function setup() {
  parts = makeParts();
  const node = addNode(parts.proxies, parts.vault, "n1");
  markHealthy(parts.proxies, node.id);
  sessions = new AuthSessionsRepo(parts.db);
  // Rebuild the runner WITH the session gate (mock provider otherwise).
  const { accounts, jobs, proxies, provider, proxyManager, runtime, vault, egress, jobsDir } =
    parts;
  withGate = new JobRunner({
    jobs,
    accounts,
    sessions,
    proxies,
    provider,
    proxyManager,
    runtime,
    vault,
    egress,
    jobsDir,
    log: () => {},
    sleep: () => Promise.resolve(),
    rng: () => 0,
  });
  return node.id;
}

function authenticate(accountId: string, email: string): void {
  sessions.ensure(accountId, "python-worker", "default");
  sessions.transition(accountId, "python-worker", "AUTHENTICATED", { email, verified: true });
}

describe("session-gated account selection", () => {
  it("fails with an auth error when no account has a verified session", async () => {
    setup();
    addAccount(parts.accounts, "acct-1");
    const job = createJob(parts.jobs, "hello");

    const result = await withGate.run(job.id).catch((e: Error) => ({ error: e }));

    const status = (parts.jobs.get(job.id) as { status: string }).status;
    expect(status === "FAILED" || "error" in (result as object)).toBe(true);
    expect(status).toBe("FAILED");
  });

  it("runs to SUCCEEDED when the selected account holds a verified session", async () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    authenticate(id, "me@gmail.com");
    const job = createJob(parts.jobs, "hello");

    const result = await withGate.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("ignores stale (expired) verification — a DB flag is not evidence", async () => {
    setup();
    const { id } = addAccount(parts.accounts, "acct-1");
    authenticate(id, "me@gmail.com");
    // Age the verification past the 10-minute TTL.
    parts.db.raw
      .prepare(
        "UPDATE auth_sessions SET last_verified_at = ? WHERE account_id = ? AND provider = ?",
      )
      .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), id, "python-worker");

    const job = createJob(parts.jobs, "hello");
    const status = parts.jobs.get(job.id) as { status: string } | null;
    await withGate.run(job.id).catch(() => {});
    expect((parts.jobs.get(job.id) as { status: string }).status).toBe("FAILED");
    expect(status).toBeTruthy();
  });

  it("honors a preferred account strictly: unusable preferred -> fail, never switch", async () => {
    setup();
    const a = addAccount(parts.accounts, "acct-A");
    const b = addAccount(parts.accounts, "acct-B");
    authenticate(b.id, "b@gmail.com"); // B is usable; A is not.

    const job = createJob(parts.jobs, "hello", { preferredAccountId: a.id });
    await withGate.run(job.id).catch(() => {});

    const row = parts.jobs.get(job.id) as { status: string; errorClass: string | null };
    expect(row.status).toBe("FAILED");
    expect(row.errorClass).toBe("auth");
  });

  it("uses the preferred account when it IS usable", async () => {
    setup();
    const a = addAccount(parts.accounts, "acct-A");
    const b = addAccount(parts.accounts, "acct-B");
    authenticate(a.id, "a@gmail.com");
    authenticate(b.id, "b@gmail.com");

    const job = createJob(parts.jobs, "hello", { preferredAccountId: a.id });
    const result = await withGate.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
  });

  it("prefers the default account over a more-recently-succeeded one", async () => {
    setup();
    const a = addAccount(parts.accounts, "acct-A"); // will be the default
    const b = addAccount(parts.accounts, "acct-B"); // more recent success
    authenticate(a.id, "a@gmail.com");
    authenticate(b.id, "b@gmail.com");
    parts.accounts.recordSuccess(b.id);
    // Make A look older.
    parts.db.raw
      .prepare("UPDATE accounts SET last_success_at = ? WHERE id = ?")
      .run(new Date(Date.now() - 86400_000).toISOString(), a.id);
    parts.accounts.setDefault(a.id, true);

    const job = createJob(parts.jobs, "hello");
    const result = await withGate.run(job.id);
    expect(result.status).toBe("SUCCEEDED");
    // The chosen account is recorded on the job row.
    const row = parts.jobs.get(job.id) as { accountId: string | null };
    expect(row.accountId).toBe(a.id);
  });
});
