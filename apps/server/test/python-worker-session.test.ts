import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PythonWorkerProvider } from "../src/providers/python-worker/python-worker-provider.js";
import type { ProviderJobRequest } from "../src/providers/types.js";
import { makeParts, type TestParts } from "./helpers.js";

/**
 * PythonWorkerProvider.runJob session-mode branches (plan: persistent notebook
 * session). The fake worker (test/fake-worker.mjs) answers `ask` with a
 * canned follow-up, `add_source` with resolved sources, and `job`/`artifact`
 * as before — so the provider's mode routing + session-addressing + anchor
 * fields are exercised end-to-end (no live notebooklm-py).
 */

const FAKE_WORKER = fileURLToPath(new URL("./fake-worker.mjs", import.meta.url));
const ACCOUNT = "acct1";

let parts: TestParts;
let sessionDir: string;
let provider: PythonWorkerProvider;

function makeProvider(): PythonWorkerProvider {
  provider = new PythonWorkerProvider({
    sessionDir,
    dataDir: parts.dir,
    pythonBin: process.execPath,
    workerPath: FAKE_WORKER,
    allowDirect: true,
    log: () => {},
  });
  return provider;
}

function baseReq(): Omit<ProviderJobRequest, "prompt" | "mode" | "output"> {
  return {
    jobId: "job_sess1234567890ab",
    accountId: ACCOUNT,
    credentialRef: `session:${ACCOUNT}`,
    language: null,
    sessionId: null,
    notebookId: null,
    notebookTitle: null,
    conversationId: null,
    sources: [],
    tunnel: null,
    egress: parts.egress,
    signal: new AbortController().signal,
    onProgress: () => {},
  };
}

beforeEach(() => {
  parts = makeParts();
  sessionDir = path.join(parts.dir, "sessions");
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
  writeFileSync(path.join(sessionDir, `nlo-${ACCOUNT}.json`), JSON.stringify({ cookies: [] }));
  makeProvider();
});

afterEach(() => {
  parts.dispose();
});

describe("PythonWorkerProvider.runJob (session modes)", () => {
  it("mode=ask runs op_ask and returns the follow-up + conversation anchor", async () => {
    const r = await provider.runJob({
      ...baseReq(),
      prompt: "follow up?",
      mode: "ask",
      output: "answer",
      sessionId: "ns_abc",
      notebookId: "nb_session",
      conversationId: "conv_prev",
    });
    expect(r.answerMarkdown).toBe("Fake follow-up for: follow up?");
    // The fake worker echoes the notebookId the provider passed (session-anchored).
    expect(r.notebookId).toBe("nb_session");
    expect(r.conversationId).toBe("conv_fake_followup");
    expect(r.providerMeta.mode).toBe("ask");
    expect(r.providerMeta.conversationId).toBe("conv_fake_followup");
    expect(r.artifacts).toEqual([]);
  });

  it("mode=add_source runs op_add_source and returns the added-source anchor", async () => {
    const r = await provider.runJob({
      ...baseReq(),
      prompt: "",
      mode: "add_source",
      output: "answer",
      sessionId: "ns_abc",
      notebookId: "nb_session",
      sources: [
        { path: "/tmp/fake-src.pdf", title: "doc.pdf", mediaType: "application/pdf" },
        { path: "/tmp/fake-src2.txt", title: "note.txt", mediaType: "text/plain" },
      ],
    });
    expect(r.answerMarkdown).toBe("منابع به نوت‌بوک اضافه شد");
    expect(r.notebookId).toBe("nb_session");
    expect(r.providerMeta.mode).toBe("add_source");
    expect(r.providerMeta.sourceIds).toEqual(["fake-src-0", "fake-src-1"]);
    expect(r.artifacts).toEqual([]);
  });

  it("mode=create (answer) runs op_job and returns the notebook + conversation anchor", async () => {
    const r = await provider.runJob({
      ...baseReq(),
      prompt: "first question",
      mode: "create",
      output: "answer",
      sessionId: "ns_new",
      notebookId: null, // notebook does not exist yet; resolved by title
      notebookTitle: "My notes · NLO-abcd1234",
      sources: [],
    });
    expect(r.answerMarkdown).toBe("Fake answer for: first question");
    expect(r.notebookId).toBe("nb_fake");
    expect(r.conversationId).toBe("conv_fake");
    expect(r.artifacts).toEqual([]);
  });

  it("mode=artifact addresses the session notebook and returns the artifact anchor", async () => {
    const r = await provider.runJob({
      ...baseReq(),
      prompt: "make an infographic",
      mode: "artifact",
      output: "infographic",
      sessionId: "ns_abc",
      notebookId: "nb_session",
      notebookTitle: "My notes · NLO-abcd1234",
    });
    expect(r.answerMarkdown).toBe("«اینفوگرافیک» آماده شد");
    expect(r.notebookId).toBe("nb_session");
    expect(r.providerMeta.kind).toBe("infographic");
    expect(r.artifacts).toHaveLength(1);
    const art = r.artifacts[0]!;
    expect(art.mediaType).toBe("image/png");
    expect(existsSync(art.path)).toBe(true);
    rmSync(art.path, { force: true });
  });

  it("no mode (legacy) still runs op_job with the per-job title and no anchor", async () => {
    const r = await provider.runJob({
      ...baseReq(),
      prompt: "plain question",
      mode: null,
      output: "answer",
      sources: [],
    });
    expect(r.answerMarkdown).toBe("Fake answer for: plain question");
    // Legacy (no session): the provider still echoes the fake notebook.
    expect(r.conversationId).toBe("conv_fake");
  });
});
