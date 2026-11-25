/**
 * Minimal client for the orchestrator job API (machine-to-machine, Bearer
 * API key). Typed on @nlo/shared's JobStatus/FailureClass.
 *
 * The server is the source of truth for file validity (extension/size/empty
 * are re-checked there); the bot's pre-checks are UX only.
 */

import { readFile, rm } from "node:fs/promises";
import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { FailureClass, JobStatus } from "@nlo/shared";

/**
 * The job-detail fields the bot needs. The server returns the full job
 * object (JobSummary schema with additionalProperties); only these are read.
 */
export interface BotJobSummary {
  id: string;
  status: JobStatus;
  answerMarkdown: string | null;
  errorClass: FailureClass | null;
  errorMessage: string | null;
  createdAt: string;
}

/** One entry of GET /api/sessions — the fields the bot reads. */
export interface BotSessionView {
  accountId: string;
  account: {
    id: string;
    label: string;
    enabled: boolean;
    displayEmail: string | null;
  };
  session: { state: string; email: string | null; lastError?: string | null } | null;
  sessionUsable: boolean;
  hasStoredFile: boolean;
}

export interface BotImportStatus {
  state: string;
  email: string | null;
  lastError: string | null;
}

export class NloApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 = network failure (server unreachable). */
    public readonly status: number,
  ) {
    super(message);
    this.name = "NloApiError";
  }

  get unreachable(): boolean {
    return this.status === 0;
  }
}

export interface JobFile {
  /** Local temp file with the content to upload. */
  path: string;
  /** Upload file name (sanitized). */
  filename: string;
  contentType?: string;
}

/** One entry of GET /api/jobs/:id/artifacts — the fields the bot reads. */
export interface JobArtifact {
  id: string;
  filename: string;
  mediaType: string;
  size: number;
  source: string;
  storageKey: string;
  createdAt: string;
}

export interface NloApiDeps {
  apiBase: string;
  apiKey: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** Upload timeout (ms); large files need headroom. */
  uploadTimeoutMs?: number;
}

const CREATE_TIMEOUT_MS = 5 * 60_000;
const SIMPLE_TIMEOUT_MS = 30_000;

export class NloApi {
  private readonly base: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (m: string) => void;
  private readonly uploadTimeoutMs: number;

  constructor(deps: NloApiDeps) {
    this.base = deps.apiBase.replace(/\/+$/, "");
    this.apiKey = deps.apiKey;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? (() => {});
    this.uploadTimeoutMs = deps.uploadTimeoutMs ?? CREATE_TIMEOUT_MS;
  }

  private async request<T>(path: string, init: RequestInit, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}${path}`, {
        ...init,
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
    } catch (e) {
      throw new NloApiError(
        controller.signal.aborted
          ? "request timed out"
          : `api unreachable: ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
    let data: unknown;
    try {
      data = await res.json();
    } catch {
      data = undefined;
    }
    if (!res.ok) {
      const env = (data ?? {}) as { error?: { message?: string } };
      throw new NloApiError(env.error?.message ?? `api error (HTTP ${res.status})`, res.status);
    }
    return data as T;
  }

  /**
   * POST /api/jobs (multipart/form-data): field `prompt` (required), optional
   * fields `title`, `output`, `language`, and 0..N `file` parts. → 201 {id,
   * status}. `output`/`language` are appended only when present.
   */
  async createJob(input: {
    prompt: string;
    title: string | null;
    files: JobFile[];
    output?: string;
    language?: string;
  }): Promise<{ id: string; status: string }> {
    const form = new FormData();
    form.append("prompt", input.prompt);
    if (input.title) form.append("title", input.title);
    if (input.output) form.append("output", input.output);
    if (input.language) form.append("language", input.language);
    for (const f of input.files) {
      const buf = await readFile(f.path);
      form.append("file", new Blob([buf], { type: f.contentType ?? "application/octet-stream" }), f.filename);
    }
    return this.request<{ id: string; status: string }>("/api/jobs", { method: "POST", body: form }, this.uploadTimeoutMs);
  }

  /** GET /api/jobs/:id → job detail (answerMarkdown holds the output). */
  async getJob(id: string): Promise<BotJobSummary> {
    const job = await this.request<BotJobSummary>(`/api/jobs/${encodeURIComponent(id)}`, { method: "GET" }, SIMPLE_TIMEOUT_MS);
    if (typeof job?.status !== "string" || !isJobStatus(job.status)) {
      throw new NloApiError(`api returned an unknown job status: ${String(job?.status)}`, 502);
    }
    return job;
  }

  /** POST /api/jobs/:id/cancel → {ok, cancelled, status, note?}. */
  async cancelJob(id: string): Promise<{ ok: boolean; cancelled: boolean; status: string; note?: string }> {
    return this.request(`/api/jobs/${encodeURIComponent(id)}/cancel`, { method: "POST" }, SIMPLE_TIMEOUT_MS);
  }

  /** GET /api/jobs/:id/artifacts → the job's provider-produced files. */
  async listJobArtifacts(jobId: string): Promise<JobArtifact[]> {
    return this.request<JobArtifact[]>(`/api/jobs/${encodeURIComponent(jobId)}/artifacts`, { method: "GET" }, SIMPLE_TIMEOUT_MS);
  }

  /**
   * GET /api/jobs/:id/artifacts/:artifactId → the file bytes, streamed to
   * destPath. Throws NloApiError on any failure (a partial dest is removed).
   */
  async downloadJobArtifact(jobId: string, artifactId: string, destPath: string): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.uploadTimeoutMs);
    let res: Response;
    try {
      res = await this.fetchImpl(
        `${this.base}/api/jobs/${encodeURIComponent(jobId)}/artifacts/${encodeURIComponent(artifactId)}`,
        {
          headers: { Authorization: `Bearer ${this.apiKey}` },
          signal: controller.signal,
        },
      );
    } catch (e) {
      clearTimeout(timer);
      throw new NloApiError(
        controller.signal.aborted
          ? "request timed out"
          : `api unreachable: ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      clearTimeout(timer);
      let msg = `artifact download failed (HTTP ${res.status})`;
      try {
        const env = (await res.clone().json()) as { error?: { message?: string } };
        if (env?.error?.message) msg = env.error.message;
      } catch {
        /* non-JSON error body */
      }
      throw new NloApiError(msg, res.status);
    }
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
        createWriteStream(destPath),
      );
    } catch (e) {
      await rm(destPath, { force: true }).catch(() => {});
      throw new NloApiError(
        `artifact download failed: ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET /api/sessions → one view per account (id, state, email, usability). */
  async listSessions(): Promise<{ provider: string; sessions: BotSessionView[] }> {
    return this.request("/api/sessions", { method: "GET" }, SIMPLE_TIMEOUT_MS);
  }

  /**
   * POST /api/sessions/:id/import → 202 {status:"accepted"}. The service
   * verification runs in the background; poll importStatus until the state
   * leaves AUTH_IN_PROGRESS.
   */
  async importCookies(accountId: string, cookies: string): Promise<{ status: string }> {
    return this.request(`/api/sessions/${encodeURIComponent(accountId)}/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cookies }),
    }, SIMPLE_TIMEOUT_MS);
  }

  /** GET /api/sessions/:id/import-status → {state, email, lastError}. */
  async importStatus(accountId: string): Promise<BotImportStatus> {
    return this.request(`/api/sessions/${encodeURIComponent(accountId)}/import-status`, { method: "GET" }, SIMPLE_TIMEOUT_MS);
  }
}

function isJobStatus(s: string): boolean {
  const known: readonly string[] = [
    "CREATED",
    "VALIDATING",
    "QUEUED",
    "WAITING_FOR_ACCOUNT",
    "WAITING_FOR_PROXY",
    "RUNNING",
    "RETRY_WAIT",
    "SUCCEEDED",
    "FAILED",
    "NEEDS_ATTENTION",
    "CANCEL_REQUESTED",
    "CANCELLED",
  ];
  return known.includes(s);
}
