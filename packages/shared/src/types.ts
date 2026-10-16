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

/**
 * Real authentication session states (per account, per provider).
 * A database status flag alone is NEVER evidence of authentication —
 * only `AUTHENTICATED` (with a recent live verification) is.
 */
export type AuthSessionState =
  | "CONFIGURED"
  | "AUTH_REQUIRED"
  | "AUTH_IN_PROGRESS"
  | "AUTHENTICATED"
  | "SESSION_EXPIRED"
  | "SESSION_INVALID"
  | "ACCESS_UNAVAILABLE"
  | "DISABLED"
  | "UNKNOWN";

export interface AuthSession {
  id: string;
  accountId: string;
  provider: string;
  /** The provider-side profile name backing this account's session. */
  profile: string;
  email: string | null;
  state: AuthSessionState;
  /** Last time the session was verified against the real service. */
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

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

/** Which diagnostic stage produced the health result. */
export type HealthCategory =
  | "config"
  | "runtime"
  | "listener"
  | "transport"
  | "tls"
  | "upstream"
  | "auth"
  | "egress"
  | "ssrf"
  | "nbl_access"
  | "unknown";

export interface ProxyHealth {
  nodeId: string;
  lastCheckedAt: string | null;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  error: string | null;
  /** When the check started (distinct from completion). */
  startedAt?: string | null;
  /** The diagnostic destination actually tested (host:port). */
  target?: string | null;
  /** Which stage the result refers to. */
  category?: HealthCategory | null;
  /** Redacted evidence string (no secrets). */
  evidence?: string | null;
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

export type ResultProvenance = "real" | "mock" | "unknown";

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
  // --- provenance (populated by the real provider) ---
  notebookId?: string | null;
  notebookTitle?: string | null;
  sourceId?: string | null;
  conversationId?: string | null;
  operationIds?: Record<string, string> | null;
  resultProvenance?: ResultProvenance;
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
