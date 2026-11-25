import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, rmSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FailureClass } from "@nlo/shared";
import {
  CapLevel,
  capabilityMatrix,
  ProviderFailure,
  type ProviderAccountStatus,
  type ProviderError,
  type ProviderJobRequest,
  type ProviderJobResult,
  type NotebookLMProvider,
} from "./types.js";

/**
 * Mock provider: deterministic, offline, safe default.
 *
 * It simulates the real audio+prompt workflow (upload source -> ask -> read
 * answer -> collect artifacts) WITHOUT any network or Google calls.
 *
 * Scenario control (for tests) via `setScenario(accountId, scenario)`:
 *   ok (default) | auth | rate_limit | transient | ambiguous
 *
 * It is clearly labeled "mock" in the UI; it never claims live capability.
 */
export type MockScenario = "ok" | "auth" | "rate_limit" | "transient" | "ambiguous";

/**
 * Deterministic fake artifact content per output kind (offline pipeline
 * exercise). Extension + mediaType mirror the real python-worker's artifacts
 * so the bot's per-kind delivery logic is exercised faithfully.
 */
const MOCK_KIND: Record<string, { ext: string; mediaType: string; content: (jobId: string) => string }> = {
  audio: { ext: ".m4a", mediaType: "audio/mp4", content: (id) => `MOCK-AUDIO ${id}` },
  infographic: { ext: ".png", mediaType: "image/png", content: (id) => `MOCK-PNG ${id}` },
  slide_deck: { ext: ".pdf", mediaType: "application/pdf", content: (id) => `MOCK-PDF ${id}` },
  report: {
    ext: ".md",
    mediaType: "text/markdown",
    content: (id) => `# Mock Report\n\nDeterministic mock report for job ${id}.\n`,
  },
  quiz: {
    ext: ".md",
    mediaType: "text/markdown",
    content: (id) => `# Mock Quiz\n\n1. Sample question? (job ${id})\n`,
  },
  flashcards: {
    ext: ".md",
    mediaType: "text/markdown",
    content: (id) => `# Mock Flashcards\n\n- Term → Definition (job ${id})\n`,
  },
  mind_map: {
    ext: ".json",
    mediaType: "application/json",
    content: (id) => JSON.stringify({ root: "mock", children: [], jobId: id }),
  },
  data_table: { ext: ".csv", mediaType: "text/csv", content: (id) => `col1,col2\njob,${id}\n` },
};

export class MockProvider implements NotebookLMProvider {
  readonly name = "mock";
  private scenarios = new Map<string, MockScenario>();
  private outDir = mkdtempSync(path.join(tmpdir(), "nlo-mock-provider-"));
  /** Test hook: sleep this long during "ask" (ms) to allow cancel/retry tests. */
  delayMs = 0;

  setScenario(accountId: string, scenario: MockScenario): void {
    this.scenarios.set(accountId, scenario);
  }

  scenario(accountId: string): MockScenario {
    return this.scenarios.get(accountId) ?? "ok";
  }

  capabilities() {
    return capabilityMatrix({
      validateConfiguration: { level: CapLevel.implementedTested },
      getAccountStatus: { level: CapLevel.implementedTested },
      uploadAudioSource: {
        level: CapLevel.implementedTested,
        note: "simulated; real provider supports .wav (mp3 unverified)",
      },
      ask: { level: CapLevel.implementedTested },
      retrieveResult: { level: CapLevel.implementedTested },
      retrieveArtifacts: {
        level: CapLevel.implementedTested,
        note: "only provider-returned files are surfaced; mock returns one sample",
      },
      cancelJob: { level: CapLevel.implementedTested, note: "mock honors cancel" },
    });
  }

  async validateConfiguration(): Promise<{ ok: boolean; issues: string[] }> {
    return { ok: true, issues: [] };
  }

  async getAccountStatus(
    accountId: string,
    _credentialRef: string,
  ): Promise<ProviderAccountStatus> {
    if (this.scenario(accountId) === "auth") {
      return { ok: false, email: null, detail: "mock: account requires re-auth" };
    }
    return { ok: true, email: "mock-account@example.com", detail: null };
  }

  async runJob(req: ProviderJobRequest): Promise<ProviderJobResult> {
    const fail = (
      failureClass: FailureClass,
      message: string,
      extra: Partial<ProviderError> = {},
    ) => {
      throw new ProviderFailure({
        failureClass,
        message,
        ambiguous: false,
        needsReauth: false,
        ...extra,
      });
    };

    if (req.signal.aborted) {
      fail("provider", "cancelled before start");
    }

    const scenario = this.scenario(req.accountId);
    req.onProgress(5, "mock: validating request");

    if (scenario === "auth") {
      fail("auth", "mock: 401 authentication required", { httpStatus: 401, needsReauth: true });
    }
    if (scenario === "rate_limit") {
      fail("rate_limit", "mock: 429 too many requests", { httpStatus: 429 });
    }
    if (scenario === "transient") {
      fail("provider", "mock: 500 transient provider error", { httpStatus: 500 });
    }
    if (scenario === "ambiguous") {
      fail("ambiguous", "mock: worker interrupted, completion unknown", { ambiguous: true });
    }

    // Simulate the workflow steps.
    req.onProgress(20, `mock: uploading ${req.sources.length} source(s)`);
    for (const s of req.sources) {
      if (!existsSync(s.path)) {
        fail("invalid_input", `mock: source file missing: ${s.title}`);
      }
    }

    req.onProgress(45, "mock: indexing sources");
    this.checkpoint(req.signal);

    req.onProgress(70, "mock: asking question");
    this.checkpoint(req.signal);
    if (this.delayMs > 0) {
      await new Promise((r) => setTimeout(r, this.delayMs));
      this.checkpoint(req.signal);
    }

    // The "ask" call goes through the egress boundary, exactly like a real
    // worker. A null tunnel or a broken scenario throws here (fail-closed);
    // the runner classifies the raw error (proxy/connectivity/...) and
    // decides retry vs. terminal.
    await req.egress.request(req.tunnel, "notebooklm.google.com:443", {
      method: "POST",
      path: "/batchexecute",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt: req.prompt, simulated: true }),
    });

    const sourceLines =
      req.sources.length === 0
        ? ["**Sources:** none"]
        : req.sources.map((s) => `- ${s.title} (uploaded, simulated)`);
    const answer = [
      "# Mock Answer",
      "",
      "> This is a **deterministic mock** response. No real NotebookLM request was made.",
      "",
      `**Prompt:** ${req.prompt}`,
      "",
      ...sourceLines,
      "",
      "The real provider (python-worker) is disabled until explicitly approved.",
    ].join("\n");

    // Produce a deterministic artifact. For a non-answer `output` the file
    // matches the kind's extension/mediaType so the bot + artifact pipeline
    // can be exercised offline; "answer" keeps the historical sample .txt.
    const output = req.output ?? "answer";
    const dir = path.join(this.outDir, req.jobId);
    mkdirSync(dir, { recursive: true });
    let answerMarkdown = answer;
    let artifact: { name: string; mediaType: string; path: string };
    if (output === "answer") {
      const artifactName = `mock-sample-${randomUUID().slice(0, 8)}.txt`;
      const artifactPath = path.join(dir, artifactName);
      writeFileSync(
        artifactPath,
        `Mock sample artifact for job ${req.jobId}\nGenerated by the mock provider (NOT a real NotebookLM output).\n`,
        "utf8",
      );
      artifact = { name: artifactName, mediaType: "text/plain", path: artifactPath };
    } else {
      const spec = MOCK_KIND[output];
      if (!spec) {
        throw new ProviderFailure({
          failureClass: "invalid_input",
          message: `mock: unknown output kind: ${output}`,
          ambiguous: false,
          needsReauth: false,
        });
      }
      const artifactName = `mock-${output}-${randomUUID().slice(0, 8)}${spec.ext}`;
      const artifactPath = path.join(dir, artifactName);
      writeFileSync(artifactPath, spec.content(req.jobId), "utf8");
      artifact = { name: artifactName, mediaType: spec.mediaType, path: artifactPath };
      answerMarkdown = `«${output}» آماده شد (mock)`;
    }

    req.onProgress(95, "mock: collecting artifacts");
    this.checkpoint(req.signal);
    req.onProgress(100, "mock: done");

    return {
      answerMarkdown,
      providerMeta: {
        provider: "mock",
        simulated: true,
        output,
        steps: ["upload", "index", "ask", "artifacts"],
        sources: req.sources.map((s) => ({
          title: s.title,
          sourceId: null,
          reused: false,
        })),
      },
      artifacts: [artifact],
    };
  }

  async cancel(_jobId: string): Promise<{ accepted: boolean; note: string }> {
    return { accepted: true, note: "mock: cancellation recorded (no real operation to stop)" };
  }

  private checkpoint(signal: AbortSignal): void {
    if (signal.aborted) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: "cancelled mid-operation",
        ambiguous: false,
        needsReauth: false,
      });
    }
  }

  dispose(): void {
    try {
      rmSync(this.outDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}
