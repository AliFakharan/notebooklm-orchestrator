import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "..");

/**
 * Minimal .env loader (mirrors @nlo/server's loadDotEnv): reads <repo>/.env
 * and sets variables that are not already set in the environment (real env
 * always wins). Called explicitly by the entrypoint; tests never call it.
 */
export function loadBotDotEnv(): void {
  const p = path.join(REPO_ROOT, ".env");
  if (!existsSync(p)) return;
  let text: string;
  try {
    text = readFileSync(p, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const i = t.indexOf("=");
    if (i <= 0) continue;
    const k = t.slice(0, i).trim();
    let v = t.slice(i + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

export interface BotConfig {
  /** Bale bot token (secret — never logged). */
  token: string;
  /** Orchestrator job API base, e.g. http://127.0.0.1:4870 (bare) or http://nlo:4870 (compose). */
  apiBase: string;
  /** Raw API key (secret — never logged). */
  apiKey: string;
  /** Optional public base URL; when set, job answers carry a /jobs/<id> link. */
  publicBaseUrl: string | null;
  /** Bale bot API base. */
  baleApiBase: string;
  /** Per-file pre-check cap (UX only; the server re-validates). */
  maxUploadBytes: number;
  /** Job polling interval (ms). */
  pollIntervalMs: number;
  /** Give up on an in-flight job after this (server job timeout 30 min + margin). */
  jobTimeoutMs: number;
  /** Idle TTL for non-IDLE flows (ms). */
  flowTtlMs: number;
  /** Max jobs per chat per 24 h. */
  maxJobsPerChatPerDay: number;
  maxTitleChars: number;
  maxPromptChars: number;
}

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) throw new Error(`env ${name} must be a positive integer`);
  return n;
}

function urlEnv(name: string, def: string): string {
  const raw = process.env[name];
  if (!raw) return def;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error(`env ${name} must be an http(s) URL`);
  }
  return raw.replace(/\/+$/, "");
}

function optionalUrlEnv(name: string): string | null {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("bad protocol");
  } catch {
    throw new Error(`env ${name} must be an http(s) URL`);
  }
  return raw.replace(/\/+$/, "");
}

/**
 * Load and validate bot configuration. Fails fast on missing token/api key.
 * Secrets are NOT logged.
 */
export function loadBotConfig(): BotConfig {
  const token = (process.env.NLO_BOT_TOKEN ?? "").trim();
  if (!token) {
    throw new Error("NLO_BOT_TOKEN is required (Bale bot token)");
  }
  const apiKey = (process.env.NLO_BOT_API_KEY ?? "").trim();
  if (!apiKey) {
    throw new Error(
      "NLO_BOT_API_KEY is required (create it in the admin UI → Infrastructure → کلیدهای API)",
    );
  }
  return {
    token,
    apiBase: urlEnv("NLO_BOT_API_BASE", "http://127.0.0.1:4870"),
    apiKey,
    publicBaseUrl: optionalUrlEnv("NLO_BOT_PUBLIC_BASE_URL"),
    baleApiBase: urlEnv("NLO_BOT_BALE_BASE", "https://tapi.bale.ai"),
    maxUploadBytes: intEnv("NLO_BOT_MAX_UPLOAD_BYTES", 100 * 1024 * 1024),
    pollIntervalMs: intEnv("NLO_BOT_POLL_INTERVAL_MS", 10_000),
    jobTimeoutMs: intEnv("NLO_BOT_JOB_TIMEOUT_MS", 40 * 60_000),
    flowTtlMs: intEnv("NLO_BOT_FLOW_TTL_MS", 60 * 60_000),
    maxJobsPerChatPerDay: intEnv("NLO_BOT_MAX_JOBS_PER_CHAT_DAY", 5),
    maxTitleChars: 200,
    maxPromptChars: 2000,
  };
}
