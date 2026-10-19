/**
 * Typed REST client for the NotebookLM Orchestrator API.
 *
 * Security notes:
 *  - The admin token is provided by the auth gate (session-only, in-memory).
 *    It is NEVER written to localStorage/sessionStorage and never logged.
 *  - Requests are same-origin in production (the backend serves this app)
 *    and proxied to the backend origin in dev (vite.config.ts).
 */
import type {
  AccountStatus,
  Artifact,
  CapabilityLevel,
  FailureClass,
  Job,
  JobEvent,
  JobStatus,
  ProxyHealth,
  ProxyNodeConfig,
} from "@nlo/shared";

export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}

/** Thrown for any non-2xx API response; carries the envelope. */
export class ApiClientError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = "ApiClientError";
  }
}

export class NetworkError extends Error {
  constructor() {
    super("ارتباط با سرور برقرار نشد.");
    this.name = "NetworkError";
  }
}

async function errorFrom(res: Response): Promise<ApiClientError | null> {
  try {
    const ct = res.headers.get("content-type") ?? "";
    if (!ct.includes("application/json")) return null;
    const body = (await res.json()) as { error?: { code?: string; message?: string } };
    if (body?.error) {
      return new ApiClientError(
        res.status,
        body.error.code ?? "unknown",
        body.error.message ?? "خطای ناشناخته",
      );
    }
  } catch {
    /* non-JSON body — fall through */
  }
  return null;
}

/**
 * Fetch a job's input audio (the server re-derives the stored path from the
 * job's own metadata — no client path input) and return it as a Blob URL.
 * The auth header goes on the fetch; the Blob URL then needs no credentials
 * for <audio> or a download anchor.
 */
export async function jobAudioBlobUrl(jobId: string): Promise<{ url: string; type: string }> {
  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}/audio`);
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    const err = await errorFrom(res);
    throw err ?? new ApiClientError(res.status, "unknown", "دریافت صدا ناموفق بود.");
  }
  const blob = await res.blob();
  return { url: URL.createObjectURL(blob), type: res.headers.get("content-type") ?? blob.type };
}

/** Download a job's input audio (triggers a browser save dialog). */
export async function downloadJobAudio(jobId: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}/audio/download`);
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    const err = await errorFrom(res);
    throw err ?? new ApiClientError(res.status, "unknown", "دانلود صدا ناموفق بود.");
  }
  const cd = res.headers.get("content-disposition") ?? "";
  const m = cd.match(/filename="([^"]*)"/);
  const filename = m && m[1] ? decodeURIComponent(m[1]) : `audio-${jobId.slice(0, 8)}`;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function parseBody(res: Response): Promise<unknown> {
  if (res.status === 204) return null;
  const ct = res.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) return res.json();
  return null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers: Record<string, string> = {
    ...(init?.headers as Record<string, string> | undefined),
  };

  let res: Response;
  try {
    res = await fetch(path, { ...init, headers });
  } catch {
    throw new NetworkError();
  }

  const body = (await parseBody(res).catch(() => null)) as T | ApiErrorBody | null | undefined;

  if (!res.ok) {
    const errBody = (body as ApiErrorBody | null)?.error;
    throw new ApiClientError(
      res.status,
      errBody?.code ?? "unknown",
      errBody?.message ?? "خطای غیرمنتظره در ارتباط با سرور.",
      errBody?.details,
    );
  }
  return body as T;
}

function jsonInit(method: string, data: unknown): RequestInit {
  return {
    method,
    headers: { "content-type": "application/json" },
    body: JSON.stringify(data),
  };
}

/* ---------------------------------- jobs ---------------------------------- */

export interface JobListQuery {
  status?: JobStatus[];
  accountId?: string;
  nodeId?: string;
  search?: string;
  limit?: number;
  offset?: number;
}

export function jobsList(q: JobListQuery = {}): Promise<{ items: Job[]; total: number }> {
  const params = new URLSearchParams();
  if (q.status?.length) params.set("status", q.status.join(","));
  if (q.accountId) params.set("accountId", q.accountId);
  if (q.nodeId) params.set("nodeId", q.nodeId);
  if (q.search) params.set("search", q.search);
  if (q.limit) params.set("limit", String(q.limit));
  if (q.offset) params.set("offset", String(q.offset));
  const qs = params.toString();
  return request(`/api/jobs${qs ? `?${qs}` : ""}`);
}

export function jobGet(id: string): Promise<Job> {
  return request(`/api/jobs/${id}`);
}

export interface CreateJobResult {
  id: string;
  status: JobStatus;
}

export function jobCreate(input: {
  prompt: string;
  title?: string;
  audio: File | null;
  preferredAccountId?: string | null;
  preferredNodeId?: string | null;
}): Promise<CreateJobResult> {
  const fd = new FormData();
  fd.append("prompt", input.prompt);
  if (input.title) fd.append("title", input.title);
  if (input.audio) fd.append("audio", input.audio);
  if (input.preferredAccountId) fd.append("preferredAccountId", input.preferredAccountId);
  if (input.preferredNodeId) fd.append("preferredNodeId", input.preferredNodeId);
  return request("/api/jobs", { method: "POST", body: fd });
}

export function jobEvents(id: string): Promise<JobEvent[]> {
  return request(`/api/jobs/${id}/events`);
}

export interface JobAttempt {
  attempt: number;
  accountId: string | null;
  nodeId: string | null;
  startedAt: string;
  endedAt: string | null;
  outcome: string;
  detail: Record<string, unknown>;
}

export function jobAttempts(id: string): Promise<JobAttempt[]> {
  return request(`/api/jobs/${id}/attempts`);
}

export function jobArtifacts(id: string): Promise<Artifact[]> {
  return request(`/api/jobs/${id}/artifacts`);
}

/**
 * Download an artifact (auth header required) and return an object URL.
 * The caller MUST revoke it with URL.revokeObjectURL when done.
 */
export async function artifactDownload(jobId: string, artifactId: string): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`/api/jobs/${jobId}/artifacts/${artifactId}`);
  } catch {
    throw new NetworkError();
  }
  if (!res.ok) {
    const body = (await parseBody(res).catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(
      res.status,
      body?.error.code ?? "unknown",
      body?.error.message ?? "دریافت فایل ناموفق بود.",
    );
  }
  const blob = await res.blob();
  const typed = new Blob([blob], { type: blob.type || "application/octet-stream" });
  return URL.createObjectURL(typed);
}

export function jobCancel(
  id: string,
): Promise<{ ok: boolean; cancelled: boolean; status: JobStatus; note?: string }> {
  return request(`/api/jobs/${id}/cancel`, { method: "POST" });
}

export function jobRequeue(id: string): Promise<{ ok: boolean; status: JobStatus }> {
  return request(`/api/jobs/${id}/requeue`, { method: "POST" });
}

/* -------------------------------- accounts -------------------------------- */

export interface Account {
  id: string;
  label: string;
  displayEmail: string;
  status: AccountStatus;
  enabled: boolean;
  hasAuth: boolean;
  lastSuccessAt: string | null;
  lastError: string | null;
  quotaNote: string | null;
  createdAt: string;
  updatedAt: string;
  isDefault: boolean;
}

export function accountsList(): Promise<Account[]> {
  return request("/api/accounts");
}

export function accountGet(id: string): Promise<Account> {
  return request(`/api/accounts/${id}`);
}

export function accountCreate(input: { label: string; displayEmail?: string }): Promise<Account> {
  return request("/api/accounts", jsonInit("POST", input));
}

export function accountUpdate(
  id: string,
  patch: Partial<Pick<Account, "label" | "displayEmail" | "status" | "enabled" | "quotaNote">>,
): Promise<Account> {
  return request(`/api/accounts/${id}`, jsonInit("PATCH", patch));
}

export function accountDelete(id: string): Promise<void> {
  return request(`/api/accounts/${id}`, { method: "DELETE" });
}

export interface AccountHealth {
  account: Account;
  ok: boolean;
  detail?: string;
}

export function accountHealthCheck(id: string): Promise<AccountHealth> {
  return request(`/api/accounts/${id}/health`, { method: "POST" });
}

export function accountSetDefault(id: string, isDefault: boolean): Promise<Account> {
  return request(`/api/accounts/${id}/default`, jsonInit("POST", { isDefault }));
}

/* --------------------------------- proxies --------------------------------- */

export interface MaskedProxyNode {
  id: string;
  enabled: boolean;
  priority: number;
  preferred: boolean;
  createdAt: string;
  updatedAt: string;
  config: Omit<ProxyNodeConfig, "uuidSecretRef"> & { uuidMasked: string };
  /** Last persisted health — only present on list responses. */
  health?: ProxyHealth | null;
}

export interface PingAllResult {
  at: string;
  /** host:port the checks ran against (notebooklm when allowlisted). */
  target: string;
  results: {
    id: string;
    ok: boolean;
    latencyMs: number | null;
    error: string | null;
    lastCheckedAt: string;
  }[];
}

export interface ProxyDetail {
  node: MaskedProxyNode;
  health: ProxyHealth;
  history: ProxyHealth[];
}

export function proxiesList(): Promise<MaskedProxyNode[]> {
  return request("/api/proxies");
}

export function proxyGet(id: string): Promise<ProxyDetail> {
  return request(`/api/proxies/${id}`);
}

export function proxyCreateFromUri(input: {
  uri: string;
  priority?: number;
}): Promise<{ node: MaskedProxyNode; warnings: string[] }> {
  return request("/api/proxies", jsonInit("POST", input));
}

export interface ManualProxyInput {
  name: string;
  server: string;
  port: number;
  uuid: string;
  transport?: "tcp" | "ws" | "grpc";
  security?: "none" | "tls" | "reality";
  sni?: string;
  wsHost?: string;
  wsPath?: string;
  pbk?: string;
  sid?: string;
  spx?: string;
  flow?: string;
  encryption?: string;
  alpn?: string;
  extra?: Record<string, string>;
  priority?: number;
}

export function proxyCreateManual(input: ManualProxyInput): Promise<{ node: MaskedProxyNode }> {
  return request("/api/proxies/manual", jsonInit("POST", input));
}

export type ProxyPatch = Partial<
  Pick<MaskedProxyNode, "enabled" | "priority" | "preferred"> & {
    name?: string;
    server?: string;
    port?: number;
    transport?: "tcp" | "ws" | "grpc";
    security?: "none" | "tls" | "reality";
    sni?: string | null;
    wsHost?: string | null;
    wsPath?: string | null;
    pbk?: string | null;
    sid?: string | null;
    spx?: string | null;
    flow?: string | null;
    encryption?: string | null;
    alpn?: string | null;
  }
>;

export function proxyUpdate(id: string, patch: ProxyPatch): Promise<MaskedProxyNode> {
  return request(`/api/proxies/${id}`, jsonInit("PATCH", patch));
}

export function proxyDelete(id: string): Promise<void> {
  return request(`/api/proxies/${id}`, { method: "DELETE" });
}

export function proxyValidate(id: string): Promise<{ ok: boolean; issues: string[] }> {
  return request(`/api/proxies/${id}/validate`, { method: "POST" });
}

export type HealthCategory =
  "config" | "runtime" | "ssrf" | "tunnel" | "tls" | "upstream" | "egress" | "nbl_access";

export interface ProxyHealthResult {
  node: MaskedProxyNode;
  ok: boolean;
  egressIp: string | null;
  latencyMs: number | null;
  error: string | null;
  /** Which stage of the staged check decided the result. */
  category?: HealthCategory;
  /** Human-readable, evidence-based explanation (never a bare status word). */
  evidence?: string | null;
  target?: string | null;
  startedAt?: string | null;
}

/**
 * Run the staged health check. `target: "notebooklm"` probes the real
 * destination (notebooklm.google.com:443) through the tunnel; the default
 * probes the allowlisted egress-echo service.
 */
export function proxyHealthCheck(
  id: string,
  opts: { target?: "egress" | "notebooklm" } = {},
): Promise<ProxyHealthResult> {
  return request(`/api/proxies/${id}/health`, jsonInit("POST", opts));
}

/** Ping every node to notebooklm.google.com:443 (bounded concurrency server-side). */
export function proxiesPingAll(): Promise<PingAllResult> {
  return request("/api/proxies/ping-all", jsonInit("POST", {}));
}

export interface ProxyRuntimeStatus {
  name: string;
  state: "available" | "not_configured" | "error";
  version?: string | null;
  binaryPath?: string | null;
  reason?: string;
}

export function proxyRuntimeStatus(): Promise<ProxyRuntimeStatus> {
  return request("/api/proxies/runtime");
}

export function proxyConnectivity(
  id: string,
): Promise<{ ok: boolean; handle?: { host: string; port: number }; error?: string }> {
  return request(`/api/proxies/${id}/connectivity`, { method: "POST" });
}

/* -------------------------------- providers -------------------------------- */

export interface ProviderInfo {
  name: string;
  isMock: boolean;
  liveDisabled: boolean;
  configured: boolean;
  issues: string[];
  capabilities: { operation: string; level: CapabilityLevel; note?: string }[];
}

export function providerInfo(): Promise<ProviderInfo> {
  return request("/api/provider");
}

/* --------------------------------- sessions --------------------------------- */

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

export interface AuthSessionView {
  id: string;
  accountId: string;
  provider: string;
  profile: string;
  email: string | null;
  state: AuthSessionState;
  lastVerifiedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface SessionAccountView {
  accountId: string;
  account: {
    id: string;
    label: string;
    enabled: boolean;
    displayEmail: string;
    authSecretRef: "present" | null;
    authProfile: string | null;
  } | null;
  session: AuthSessionView | null;
  sessionUsable: boolean;
  hasStoredFile: boolean;
}

export interface SessionsOverview {
  provider: string;
  interactiveLogin: boolean;
  sessions: SessionAccountView[];
}

export function sessionsList(): Promise<SessionsOverview> {
  return request("/api/sessions");
}

export function sessionGet(accountId: string): Promise<SessionAccountView> {
  return request(`/api/sessions/${accountId}`);
}

/** Start interactive browser login (blocks until sign-in completes or times out). */
export function sessionLogin(
  accountId: string,
  opts: {
    timeoutSec?: number;
    headless?: boolean;
    browser?: "chromium" | "chrome" | "msedge";
  } = {},
): Promise<{ session: AuthSessionView; email: string | null }> {
  return request(`/api/sessions/${accountId}/login`, jsonInit("POST", opts));
}

/**
 * Browsers the server allowlists as cookie sources for session import.
 * Chromium-family profiles can be targeted with "name::Profile" (e.g.
 * "chrome::Profile 1"); the base name must be in this list.
 */
export const BROWSER_COOKIE_OPTIONS = [
  "auto",
  "chrome",
  "firefox",
  "chromium",
  "brave",
  "edge",
  "opera",
  "vivaldi",
  "librewolf",
  "zen",
  "cachy",
] as const;

/**
 * Import Google cookies from an installed, non-automated browser. This is the
 * supported path when Google rejects the app's automated Playwright browser
 * ("may not be secure"): sign in with your normal browser, then let the app
 * copy the session locally. The server verifies the result against the real
 * service before reporting success.
 */
export function sessionBrowserImport(
  accountId: string,
  body: { browser: string; account?: string; timeoutSec?: number },
): Promise<{ session: AuthSessionView; email: string | null; routingNote?: string }> {
  return request(`/api/sessions/${accountId}/browser-import`, jsonInit("POST", body));
}

export interface SessionVerifyResult {
  ok: boolean;
  email: string | null;
  detail: string | null;
  session?: AuthSessionView;
  note?: string;
  needsLogin?: boolean;
  /** True when the verified identity does not match this account's expected email. */
  mismatch?: boolean;
}

export function sessionVerify(accountId: string): Promise<SessionVerifyResult> {
  return request(`/api/sessions/${accountId}/verify`, { method: "POST" });
}

export function sessionRefresh(accountId: string): Promise<SessionVerifyResult> {
  return request(`/api/sessions/${accountId}/refresh`, { method: "POST" });
}

export function sessionImport(
  accountId: string,
  body: { base64?: string; serverPath?: string },
): Promise<SessionVerifyResult> {
  return request(`/api/sessions/${accountId}/import`, jsonInit("POST", body));
}

export function sessionLogout(accountId: string): Promise<{ ok: boolean }> {
  return request(`/api/sessions/${accountId}`, { method: "DELETE" });
}

export const SESSION_STATE_LABELS: Record<AuthSessionState, string> = {
  CONFIGURED: "پیکربندی‌شده",
  AUTH_REQUIRED: "نیازمند ورود",
  AUTH_IN_PROGRESS: "در حال ورود",
  AUTHENTICATED: "واردشده (تأییدشده)",
  SESSION_EXPIRED: "منقضی‌شده",
  SESSION_INVALID: "نامعتبر",
  ACCESS_UNAVAILABLE: "دسترسی در دسترس نیست",
  DISABLED: "غیرفعال",
  UNKNOWN: "نامشخص",
};

/* --------------------------------- settings --------------------------------- */

export interface RuntimeSettings {
  settings: { jobsMaxAttemptsDefault: number; jobsMaxPromptChars: number };
  defaults: Record<string, number>;
  writableKeys: string[];
}

export function settingsGet(): Promise<RuntimeSettings> {
  return request("/api/settings");
}

export function settingsPut(
  patch: Partial<{ jobsMaxAttemptsDefault: number; jobsMaxPromptChars: number }>,
): Promise<{ ok: boolean; updated: string[] }> {
  return request("/api/settings", jsonInit("PUT", patch));
}

export interface SecretEntry {
  ref: string;
  kind: string;
  updatedAt: string;
}

export function secretsList(): Promise<{ secrets: SecretEntry[] }> {
  return request("/api/secrets");
}

/* ---------------------------------- health ---------------------------------- */

export interface ReadyInfo {
  ok: boolean;
  ready: boolean;
  provider: { name: string; configured: boolean; issues: string[] };
  proxyRuntime:
    | { state: "available"; name: string }
    | { state: "not_configured"; name: string; reason: string };
  liveDisabled: boolean;
}

export function healthReady(): Promise<ReadyInfo> {
  return request("/api/health/ready");
}

/* ------------------------------- status labels ------------------------------- */

export const JOB_STATUS_LABELS: Record<JobStatus, string> = {
  CREATED: "ایجادشده",
  VALIDATING: "در حال اعتبارسنجی",
  QUEUED: "در صف",
  WAITING_FOR_ACCOUNT: "در انتظار حساب",
  WAITING_FOR_PROXY: "در انتظار پراکسی",
  RUNNING: "در حال اجرا",
  RETRY_WAIT: "در انتظار تلاش مجدد",
  SUCCEEDED: "موفق",
  FAILED: "ناموفق",
  NEEDS_ATTENTION: "نیازمند بررسی",
  CANCEL_REQUESTED: "درخواست لغو",
  CANCELLED: "لغو‌شده",
};

export const ACCOUNT_STATUS_LABELS: Record<AccountStatus, string> = {
  ACTIVE: "فعال",
  DEGRADED: "کاهش‌یافته",
  RATE_LIMITED: "محدودشدن نرخ",
  AUTH_REQUIRED: "نیازمند احراز هویت",
  DISABLED: "غیرفعال",
  UNKNOWN: "نامشخص",
};

export const FAILURE_CLASS_LABELS: Record<FailureClass, string> = {
  auth: "احراز هویت",
  rate_limit: "محدودیت نرخ",
  invalid_input: "ورودی نامعتبر",
  connectivity: "اتصال",
  provider: "ارائه‌دهنده",
  proxy: "پراکسی",
  ambiguous: "دوامدار",
  unknown: "نامشخص",
};
