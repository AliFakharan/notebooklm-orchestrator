import type { FailureClass } from "@nlo/shared";
import type { ProviderEgress } from "../proxy/egress.js";
import type { TunnelHandle } from "../proxy/runtime.js";

/**
 * Provider abstraction. The application never talks to NotebookLM directly;
 * it goes through this interface. Each implementation MUST declare honest
 * capability levels (never claim a fake capability).
 *
 * The "audio + prompt" workflow, concretely:
 *   uploadAudioSource -> add an audio file as a notebook source
 *   ask              -> submit the prompt against the notebook
 *   retrieveResult   -> read the grounded answer as Markdown
 *   retrieveArtifacts-> collect ONLY files the provider actually returned
 *
 * These are distinct operations and are not interchangeable with
 * "generate audio overview" (which is the opposite direction).
 */

export interface ProviderAccountStatus {
  ok: boolean;
  email: string | null;
  detail: string | null;
}

export interface ProviderJobRequest {
  jobId: string;
  accountId: string;
  /** Opaque per-account credential handle resolved by the provider (not a secret). */
  credentialRef: string;
  prompt: string;
  /**
   * Path to the uploaded audio (server-side, sanitized). `null` when the
   * request has no audio. The provider decides support.
   */
  audioPath: string | null;
  audioMediaType: string | null;
  /**
   * The ONLY network route the provider may use. `null` means "no approved
   * tunnel" — a live provider MUST then refuse (fail-closed). Mock ignores.
   */
  tunnel: TunnelHandle | null;
  egress: ProviderEgress;
  signal: AbortSignal;
  onProgress: (progress: number, note: string) => void;
}

export interface ProviderJobResult {
  answerMarkdown: string | null;
  providerMeta: Record<string, unknown>;
  /** Files the provider actually produced. Application must not fabricate. */
  artifacts: { name: string; mediaType: string; path: string }[];
}

export interface ProviderError {
  failureClass: FailureClass;
  message: string;
  httpStatus?: number;
  /** True when the operation's completion is unknown (must NOT auto-retry). */
  ambiguous: boolean;
  /** True when this error indicates the account needs re-auth. */
  needsReauth: boolean;
}

export class ProviderFailure extends Error {
  constructor(public readonly info: ProviderError) {
    super(info.message);
    this.name = "ProviderFailure";
  }
}

export interface NotebookLMProvider {
  readonly name: string;
  capabilities(): { operation: string; level: string; note?: string }[];
  validateConfiguration(): Promise<{ ok: boolean; issues: string[] }>;
  getAccountStatus(accountId: string, credentialRef: string): Promise<ProviderAccountStatus>;
  /**
   * Run the full audio+prompt workflow for a job. Must throw ProviderFailure
   * on any error. Must not fabricate results.
   */
  runJob(req: ProviderJobRequest): Promise<ProviderJobResult>;
  cancel(jobId: string): Promise<{ accepted: boolean; note: string }>;
}

/** Capability level constants (mirror shared). */
export const CapLevel = {
  implementedTested: "implemented_tested",
  implementedUntestedLive: "implemented_untested_live",
  experimental: "experimental",
  unsupported: "unsupported",
  unavailable: "unavailable",
} as const;

/**
 * Honest capability declaration helper. Providers must list every operation
 * they might be asked to do, with a truthful level.
 */
export function capabilityMatrix(ops: Record<string, { level: string; note?: string }>): {
  operation: string;
  level: string;
  note?: string;
}[] {
  return Object.entries(ops).map(([operation, v]) => ({ operation, ...v }));
}
