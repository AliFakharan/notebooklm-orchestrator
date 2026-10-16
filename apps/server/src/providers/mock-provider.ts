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
    req.onProgress(20, "mock: uploading audio source");
    if (req.audioPath && !existsSync(req.audioPath)) {
      fail("invalid_input", "mock: audio file missing");
    }

    req.onProgress(45, "mock: indexing source");
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

    const answer = [
      "# Mock Answer",
      "",
      "> This is a **deterministic mock** response. No real NotebookLM request was made.",
      "",
      `**Prompt:** ${req.prompt}`,
      "",
      req.audioPath ? "**Audio source:** uploaded (simulated)" : "**Audio source:** none",
      "",
      "The real provider (python-worker) is disabled until explicitly approved.",
    ].join("\n");

    // Produce ONE sample artifact to exercise the artifact pipeline. Mock
    // artifacts are clearly application-generated in provenance.
    const artifactName = `mock-sample-${randomUUID().slice(0, 8)}.txt`;
    const artifactPath = path.join(this.outDir, req.jobId, artifactName);
    mkdirSync(path.dirname(artifactPath), { recursive: true });
    writeFileSync(
      artifactPath,
      `Mock sample artifact for job ${req.jobId}\nGenerated by the mock provider (NOT a real NotebookLM output).\n`,
      "utf8",
    );

    req.onProgress(95, "mock: collecting artifacts");
    this.checkpoint(req.signal);
    req.onProgress(100, "mock: done");

    return {
      answerMarkdown: answer,
      providerMeta: {
        provider: "mock",
        simulated: true,
        steps: ["upload", "index", "ask", "artifacts"],
      },
      artifacts: [{ name: artifactName, mediaType: "text/plain", path: artifactPath }],
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
