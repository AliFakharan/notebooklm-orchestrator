/**
 * Shared domain types for NotebookLM Orchestrator.
 * These are transport-neutral: consumed by server, web, and tests.
 */

export type JobStatus =
  | "CREATED"
  | "VALIDATING"
  | "QUEUED"
  | "WAITING_FOR_ACCOUNT"
  | "WAITING_FOR_PROXY"
  | "RUNNING"
  | "RETRY_WAIT"
  | "SUCCEEDED"
  | "FAILED"
  | "NEEDS_ATTENTION"
  | "CANCEL_REQUESTED"
  | "CANCELLED";

export const JOB_TERMINAL_STATUSES: readonly JobStatus[] = [
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
] as const;

export type AccountStatus =
  "ACTIVE" | "DEGRADED" | "RATE_LIMITED" | "AUTH_REQUIRED" | "DISABLED" | "UNKNOWN";

export type ProxyTransport = "tcp" | "ws" | "grpc";
export type ProxySecurity = "none" | "tls" | "reality";

/**
 * Normalized VLESS node configuration.
 * Unknown URI parameters are preserved in `extra` (never silently dropped).
 */
export interface ProxyNodeConfig {
  name: string;
  server: string;
  port: number;
  /** Reference into the secret vault. The UUID itself is never stored in DB rows. */
  uuidSecretRef: string;
  transport: ProxyTransport;
  security: ProxySecurity;
  sni?: string;
  wsHost?: string;
  wsPath?: string;
  pbk?: string;
  sid?: string;
  spx?: string;
  flow?: string;
  encryption?: string;
  alpn?: string;
  /** Unknown parameters preserved verbatim (key = param name). */
  extra: Record<string, string>;
}

export interface ProxyNode {
  id: string;
  config: ProxyNodeConfig;
  enabled: boolean;
  /** Lower value = higher priority. */
  priority: number;
  preferred: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ProxyHealth {
  nodeId: string;
  lastCheckedAt: string | null;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  error: string | null;
}

export type ArtifactSource = "provider" | "application";

export interface Artifact {
  id: string;
  jobId: string;
  filename: string;
  mediaType: string;
  size: number;
  source: ArtifactSource;
  storageKey: string;
  createdAt: string;
}

export interface JobInput {
  prompt: string;
  audio: {
    originalName: string;
    mediaType: string;
    size: number;
    sha256: string;
    /** Supported-ness as verified against the provider (not a guess). */
    providerConfirmed: boolean;
  };
  preferredAccountId: string | null;
  preferredNodeId: string | null;
}

export interface Job {
  id: string;
  status: JobStatus;
  input: JobInput;
  accountId: string | null;
  nodeId: string | null;
  attempt: number;
  maxAttempts: number;
  progress: number;
  progressNote: string | null;
  errorClass: FailureClass | null;
  errorMessage: string | null;
  answerMarkdown: string | null;
  resultProviderMeta: Record<string, unknown> | null;
  configSnapshot: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  finishedAt: string | null;
}

export type FailureClass =
  | "auth"
  | "rate_limit"
  | "invalid_input"
  | "connectivity"
  | "provider"
  | "proxy"
  | "ambiguous"
  | "unknown";

export interface JobEvent {
  id: string;
  jobId: string;
  at: string;
  type: string;
  message: string;
  data: Record<string, unknown>;
}

/** Capability truthfulness levels — never claim more than this. */
export type CapabilityLevel =
  | "implemented_tested"
  | "implemented_untested_live"
  | "experimental"
  | "unsupported"
  | "unavailable";

export interface ProviderCapability {
  operation: string;
  level: CapabilityLevel;
  note?: string;
}
