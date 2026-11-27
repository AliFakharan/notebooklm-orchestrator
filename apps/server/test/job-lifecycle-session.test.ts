import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { safeName, type Job, type JobMode, type JobOutputKind } from "@nlo/shared";
import {
  addAccount,
  addNode,
  makeParts,
  markHealthy,
  type TestParts,
} from "./helpers.js";
import { JobRunner } from "../src/queue/job-runner.js";
import { NotebookSessionsRepo } from "../src/domain/notebook-sessions.repo.js";
import type { ProviderJobRequest } from "../src/providers/types.js";

/**
 * JobRunner + persistent notebook session: the runner resolves a session anchor
 * once per job, threads the session's notebook/conversation/account into the
 * provider call, writes the result back onto the session, and fails closed when
 * the session cannot serve the job (closed / expired / no notebook yet / unknown).
 *
 * `makeParts` does not wire the notebook-session repo, so each test builds its
 * own JobRunner around the same in-memory stack with the repo attached.
 */

let parts: TestParts;
afterEach(() => parts.dispose());

function setup(): {
  parts: TestParts;
  sessions: NotebookSessionsRepo;
  runner: JobRunner;
  acct: { id: string };
} {
  const p = makeParts();
  parts = p;
  const sessions = new NotebookSessionsRepo(p.db);
  const runner = new JobRunner({
    jobs: p.jobs,
    accounts: p.accounts,
    proxies: p.proxies,
    provider: p.provider,
    proxyManager: p.proxyManager,
    runtime: p.runtime,
    vault: p.vault,
    egress: p.egress,
    jobsDir: p.jobsDir,
    log: () => {},
    sleep: () => Promise.resolve(),
    rng: () => 0,
    notebookSessions: sessions,
  });
  const acct = addAccount(p.accounts, "acct-1");
  const node = addNode(p.proxies, p.vault, "n1");
  markHealthy(p.proxies, node.id);
  return { parts: p, sessions, runner, acct };
}

interface NewJobOpts {
  sessionId?: string | null;
  mode?: JobMode | null;
  prompt?: string;
  output?: JobOutputKind | null;
  sources?: { name: string; content: string; mediaType: string }[];
}

function newSessionJob(parts: TestParts, opts: NewJobOpts): Job {
  const files = opts.sources ?? [];
  const job = parts.jobs.create({
    input: {
      prompt: opts.prompt ?? "session prompt",
      sources: files.map((f, i) => ({
        originalName: f.name,
        storageName: `${i + 1}-${safeName(f.name)}`,
        mediaType: f.mediaType,
        size: Buffer.byteLength(f.content),
        sha256: createHash("sha256").update(f.content).digest("hex"),
        providerConfirmed: true,
      })),
      preferredAccountId: null,
      preferredNodeId: null,
      output: opts.output ?? "answer",
      sessionId: opts.sessionId ?? null,
      mode: opts.mode ?? null,
    },
    configSnapshot: { provider: "mock" },
  });
  if (files.length) {
    const dir = path.join(parts.jobsDir, job.id, "input", "sources");
    mkdirSync(dir, { recursive: true });
    files.forEach((f, i) => {
      writeFileSync(path.join(dir, `${i + 1}-${safeName(f.name)}`), f.content);
    });
  }
  return job;
}

/** Wrap the mock provider to record the ProviderJobRequest the runner built. */
function captureRunJob(parts: TestParts): {
  calls: ProviderJobRequest[];
  setResult: (r: Partial<import("../src/providers/types.js").ProviderJobResult>) => void;
} {
  const calls: ProviderJobRequest[] = [];
  const orig = parts.provider.runJob.bind(parts.provider);
  let patch: Partial<import("../src/providers/types.js").ProviderJobResult> = {};
  parts.provider.runJob = async (req) => {
    calls.push(req);
    const res = await orig(req);
    return { ...res, ...patch };
  };
  return { calls, setResult: (r) => (patch = { ...patch, ...r }) };
}

describe("mode=create binds the session anchor", () => {
  it("anchors notebook + conversation + owning account on success", async () => {
    const { parts, sessions, runner, acct } = setup();
    const session = sessions.create({ chatId: 101, notebookTitle: "My notes · NLO-x" });
    const job = newSessionJob(parts, { sessionId: session.id, mode: "create", prompt: "open it" });

    const result = await runner.run(job.id);

    expect(result.status).toBe("SUCCEEDED");
    const after = sessions.get(session.id)!;
    expect(after.status).toBe("open");
    expect(after.notebookId).toBe(`mock-nb-${job.id}`);
    expect(after.conversationId).toBe("mock-conv");
    expect(after.accountId).toBe(acct.id);
  });
});

describe("mode=ask follows the session", () => {
  it("threads the prior conversation + notebook in, advances the thread out, pins the owner", async () => {
    const { parts, sessions, runner, acct } = setup();
    const session = sessions.create({ chatId: 102, notebookTitle: "session title" });
    const first = newSessionJob(parts, { sessionId: session.id, mode: "create", prompt: "open" });
    await runner.run(first.id);
    const afterCreate = sessions.get(session.id)!;
    const priorConv = afterCreate.conversationId!;
    const existingNb = afterCreate.notebookId!;

    const { calls, setResult } = captureRunJob(parts);
    // Real worker: an ask addresses the existing notebook and returns it
    // unchanged while advancing the conversation thread.
    setResult({ conversationId: "mock-conv-ADVANCED", notebookId: existingNb });
    const askJob = newSessionJob(parts, { sessionId: session.id, mode: "ask", prompt: "follow up" });
    const result = await runner.run(askJob.id);

    expect(result.status).toBe("SUCCEEDED");
    const call = calls[0]!;
    expect(call.sessionId).toBe(session.id);
    expect(call.mode).toBe("ask");
    expect(call.notebookId).toBe(afterCreate.notebookId); // existing notebook (no create)
    expect(call.notebookTitle).toBe("session title");
    expect(call.conversationId).toBe(priorConv); // prior thread threaded in
    expect(call.accountId).toBe(acct.id); // pinned to the session owner

    const after = sessions.get(session.id)!;
    expect(after.conversationId).toBe("mock-conv-ADVANCED"); // advanced out
    expect(after.notebookId).toBe(afterCreate.notebookId); // notebook preserved
  });

  it("pins a follow-up to the session owner even when another account is the preferred default", async () => {
    const { parts, sessions, runner, acct: aDefault } = setup();
    const aOwner = addAccount(parts.accounts, "acct-owner");
    parts.accounts.recordSuccess(aDefault.id); // make the default account look more recent

    const session = sessions.create({ chatId: 200, notebookTitle: "t" });
    sessions.touch(session.id, { notebookId: "nb_owner", conversationId: "c0", accountId: aOwner.id });

    const { calls } = captureRunJob(parts);
    const job = newSessionJob(parts, { sessionId: session.id, mode: "ask", prompt: "hi" });
    const result = await runner.run(job.id);

    expect(result.status).toBe("SUCCEEDED");
    expect(calls[0]!.accountId).toBe(aOwner.id); // pinned, NOT aDefault
  });
});

describe("mode=add_source appends to the session notebook", () => {
  it("targets the existing notebook, passes the new source, refreshes (not rebinds) the session", async () => {
    const { parts, sessions, runner, acct } = setup();
    const session = sessions.create({ chatId: 103, notebookTitle: "t" });
    const first = newSessionJob(parts, {
      sessionId: session.id,
      mode: "create",
      prompt: "open",
      sources: [{ name: "a.txt", content: "x", mediaType: "text/plain" }],
    });
    await runner.run(first.id);
    const afterCreate = sessions.get(session.id)!;

    const { calls } = captureRunJob(parts);
    const addJob = newSessionJob(parts, {
      sessionId: session.id,
      mode: "add_source",
      prompt: "add file",
      sources: [{ name: "new.pdf", content: "PDF", mediaType: "application/pdf" }],
    });
    const result = await runner.run(addJob.id);

    expect(result.status).toBe("SUCCEEDED");
    expect(result.answerMarkdown).toBe("منابع به نوت‌بوک اضافه شد");
    const call = calls[0]!;
    expect(call.mode).toBe("add_source");
    expect(call.notebookId).toBe(afterCreate.notebookId); // appended to existing notebook
    expect(call.sources.map((s) => s.title)).toContain("new.pdf");
    const after = sessions.get(session.id)!;
    expect(after.notebookId).toBe(afterCreate.notebookId); // unchanged
    expect(after.accountId).toBe(acct.id); // unchanged
    expect(after.status).toBe("open");
  });
});

describe("mode=artifact generates output on the session notebook", () => {
  it("succeeds with ZERO job sources (the notebook's sources are used) and an empty prompt", async () => {
    const { parts, sessions, runner } = setup();
    const session = sessions.create({ chatId: 107, notebookTitle: "t" });
    const first = newSessionJob(parts, {
      sessionId: session.id,
      mode: "create",
      prompt: "open",
      sources: [{ name: "a.txt", content: "x", mediaType: "text/plain" }],
    });
    await runner.run(first.id);
    const afterCreate = sessions.get(session.id)!;

    const { calls } = captureRunJob(parts);
    // Bot /infographic in-session: mode=artifact, output=infographic, no
    // sources, no prompt — must pass validation (previously failed with
    // `output "infographic" requires at least one source file`).
    const artJob = newSessionJob(parts, {
      sessionId: session.id,
      mode: "artifact",
      prompt: "",
      output: "infographic",
    });
    const result = await runner.run(artJob.id);

    expect(result.status).toBe("SUCCEEDED");
    const call = calls[0]!;
    expect(call.mode).toBe("artifact");
    expect(call.notebookId).toBe(afterCreate.notebookId);
    expect(call.sources).toHaveLength(0);
    const after = sessions.get(session.id)!;
    expect(after.notebookId).toBe(afterCreate.notebookId); // unchanged
  });

  it("a NON-session job with a non-answer output and zero sources still fails closed", async () => {
    const { parts, sessions, runner } = setup();
    sessions.create({ chatId: 108, notebookTitle: "t" });
    const job = newSessionJob(parts, { output: "infographic" }); // no mode/session/sources

    const result = await runner.run(job.id);

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("invalid_input");
    expect(result.errorMessage).toMatch(/requires at least one source file/);
  });
});

describe("fail-closed when the session cannot serve the job", () => {
  it("a closed session fails the job (invalid_input) without a provider call", async () => {
    const { parts, sessions, runner, acct } = setup();
    const session = sessions.create({ chatId: 104, notebookTitle: "t" });
    sessions.touch(session.id, { notebookId: "nb_1", conversationId: "c1", accountId: acct.id });
    sessions.close(session.id);

    const { calls } = captureRunJob(parts);
    const job = newSessionJob(parts, { sessionId: session.id, mode: "ask", prompt: "hi" });
    const result = await runner.run(job.id);

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("invalid_input");
    expect(result.errorMessage).toMatch(/notebook session is closed/);
    expect(calls).toHaveLength(0);
  });

  it("a follow-up with no notebook yet fails the job without a provider call", async () => {
    const { parts, sessions, runner } = setup();
    const session = sessions.create({ chatId: 105, notebookTitle: "t" }); // open, no notebook

    const { calls } = captureRunJob(parts);
    const job = newSessionJob(parts, { sessionId: session.id, mode: "ask", prompt: "hi" });
    const result = await runner.run(job.id);

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("invalid_input");
    expect(result.errorMessage).toMatch(/no notebook yet/);
    expect(calls).toHaveLength(0);
  });

  it("an unknown session id fails the job without a provider call", async () => {
    const { parts, runner } = setup();
    const { calls } = captureRunJob(parts);
    const job = newSessionJob(parts, {
      sessionId: "ns_deadbeefdeadbeefdeadbeefdeadbeef",
      mode: "create",
      prompt: "hi",
    });
    const result = await runner.run(job.id);

    expect(result.status).toBe("FAILED");
    expect(result.errorClass).toBe("invalid_input");
    expect(result.errorMessage).toMatch(/notebook session not found/);
    expect(calls).toHaveLength(0);
  });
});

describe("unanchored jobs are unaffected", () => {
  it("a job with no sessionId/mode runs as before and touches no session", async () => {
    const { parts, sessions, runner } = setup();
    const session = sessions.create({ chatId: 106, notebookTitle: "t" });
    const job = newSessionJob(parts, { prompt: "plain job" }); // no session/mode
    const result = await runner.run(job.id);

    expect(result.status).toBe("SUCCEEDED");
    const after = sessions.get(session.id)!;
    expect(after.notebookId).toBeNull(); // untouched
    expect(after.status).toBe("open");
  });
});
