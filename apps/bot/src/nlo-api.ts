/**
 * Minimal client for the orchestrator job API (machine-to-machine, Bearer
 * API key). Typed on @nlo/shared's JobStatus/FailureClass.
 *
 * The server is the source of truth for file validity (extension/size/empty
 * are re-checked there); the bot's pre-checks are UX only.
 */

import { readFile } from "node:fs/promises";
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
   * POST /api/jobs (multipart/form-data): field `prompt` (required), field
   * `title` (optional), 0..N `file` parts. → 201 {id, status}.
   */
  async createJob(input: {
    prompt: string;
    title: string | null;
    files: JobFile[];
  }): Promise<{ id: string; status: string }> {
    const form = new FormData();
    form.append("prompt", input.prompt);
    if (input.title) form.append("title", input.title);
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
