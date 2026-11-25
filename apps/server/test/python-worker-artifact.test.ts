import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PythonWorkerProvider } from "../src/providers/python-worker/python-worker-provider.js";
import type { ProviderJobRequest } from "../src/providers/types.js";
import { makeParts, type TestParts } from "./helpers.js";

/**
 * PythonWorkerProvider.runJob artifact branch (plan: NotebookLM artifacts).
 * The fake worker (test/fake-worker.mjs, spawned via `node`) answers the
 * `job` op with a canned text answer and the `artifact` op by writing a real
 * temp file per output kind, so the provider's mapping + fail-closed file
 * check are exercised end-to-end (no live notebooklm-py).
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
    allowDirect: true, // null tunnel is fine (fail-closed only when nodes exist)
    log: () => {},
  });
  return provider;
}

function makeReq(
  output: "answer" | "audio" | "report" | "infographic",
  language?: string | null,
): ProviderJobRequest {
  return {
    jobId: "job_abc123def4567890",
    accountId: ACCOUNT,
    credentialRef: `session:${ACCOUNT}`,
    prompt: "make a thing",
    output,
    language: language ?? null,
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

describe("PythonWorkerProvider.runJob", () => {
  it("answer output uses the job op (text answer, no artifacts)", async () => {
    const r = await provider.runJob(makeReq("answer"));
    expect(r.answerMarkdown).toBe("Fake answer for: make a thing");
    expect(r.artifacts).toEqual([]);
    expect(r.providerMeta.simulated).toBe(false);
    expect(r.providerMeta.output).toBeUndefined();
  });

  it("audio output uses the artifact op and returns the generated file", async () => {
    const r = await provider.runJob(makeReq("audio", "fa"));
    expect(r.answerMarkdown).toBe("«پادکست» آماده شد");
    expect(r.providerMeta.output).toBe("audio");
    expect(r.providerMeta.kind).toBe("audio");
    expect(r.artifacts).toHaveLength(1);
    const art = r.artifacts[0]!;
    expect(art.mediaType).toBe("audio/mp4");
    expect(art.name).toMatch(/\.m4a$/);
    expect(existsSync(art.path)).toBe(true);
    rmSync(art.path, { force: true });
  });

  it("report output maps to a markdown artifact + Persian caption", async () => {
    const r = await provider.runJob(makeReq("report"));
    expect(r.answerMarkdown).toBe("«گزارش» آماده شد");
    const art = r.artifacts[0]!;
    expect(art.mediaType).toBe("text/markdown");
    expect(art.name).toMatch(/\.md$/);
    rmSync(art.path, { force: true });
  });

  it("infographic output maps to a png artifact", async () => {
    const r = await provider.runJob(makeReq("infographic"));
    expect(r.answerMarkdown).toBe("«اینفوگرافیک» آماده شد");
    const art = r.artifacts[0]!;
    expect(art.mediaType).toBe("image/png");
    expect(art.name).toMatch(/\.png$/);
    rmSync(art.path, { force: true });
  });
});
