import { mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface AppConfig {
  host: string;
  port: number;
  dataDir: string;
  adminToken: string | null;
  vaultKey: string | null;
  provider: "mock" | "python-worker";
  proxyRuntime: "mock" | "xray";
  maxUploadBytes: number;
  allowedAudioExtensions: string[];
  liveTestsEnabled: boolean;
  /** SSRF allowlist for health checks (host[:port] entries). */
  healthAllowlist: string[];
}

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..", "..");

function intEnv(name: string, def: number): number {
  const raw = process.env[name];
  if (!raw) return def;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) throw new Error(`env ${name} must be a non-negative integer`);
  return n;
}

function boolEnv(name: string, def: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return def;
  if (["1", "true", "yes", "on"].includes(raw.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(raw.toLowerCase())) return false;
  throw new Error(`env ${name} must be a boolean`);
}

/**
 * Load and validate configuration. Fails fast on invalid values.
 * Secrets are NOT logged. `dataDir` is created if missing.
 */
export function loadConfig(overrides: Partial<Record<string, string>> = {}): AppConfig {
  const env = (name: string): string | undefined =>
    overrides[name] !== undefined ? overrides[name] : process.env[name];

  const host = env("NLO_HOST") ?? "127.0.0.1";
  if (!/^[a-fA-F0-9:.]+$/.test(host) && host !== "localhost") {
    throw new Error(`invalid NLO_HOST: ${host}`);
  }

  const dataDir = path.resolve(env("NLO_DATA_DIR") ?? path.join(REPO_ROOT, "data"));
  mkdirSync(dataDir, { recursive: true });

  const vaultKey = env("NLO_VAULT_KEY");
  if (vaultKey !== undefined && !/^[0-9a-fA-F]{64}$/.test(vaultKey)) {
    throw new Error("NLO_VAULT_KEY must be 64 hex chars (32 bytes)");
  }

  const provider = env("NLO_PROVIDER") ?? "mock";
  if (!["mock", "python-worker"].includes(provider)) {
    throw new Error("NLO_PROVIDER must be 'mock' or 'python-worker'");
  }
  const proxyRuntime = env("NLO_PROXY_RUNTIME") ?? "mock";
  if (!["mock", "xray"].includes(proxyRuntime)) {
    throw new Error("NLO_PROXY_RUNTIME must be 'mock' or 'xray'");
  }

  const maxUploadBytes = intEnv("NLO_MAX_UPLOAD_BYTES", 200 * 1024 * 1024);
  if (maxUploadBytes > 5 * 1024 * 1024 * 1024) {
    throw new Error("NLO_MAX_UPLOAD_BYTES is unreasonably large");
  }

  const allowedAudioExtensions = (env("NLO_ALLOWED_AUDIO_EXTENSIONS") ?? "wav,mp3,m4a,ogg,flac")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const healthAllowlist = (
    env("NLO_HEALTH_ALLOWLIST") ?? "api.ipify.org:443,notebooklm.google.com:443"
  )
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  return {
    host,
    port: intEnv("NLO_PORT", 4870),
    dataDir,
    adminToken: env("NLO_ADMIN_TOKEN") || null,
    vaultKey: vaultKey ?? null,
    provider: provider as AppConfig["provider"],
    proxyRuntime: proxyRuntime as AppConfig["proxyRuntime"],
    maxUploadBytes,
    allowedAudioExtensions,
    liveTestsEnabled: boolEnv("NLO_LIVE_TESTS", false),
    healthAllowlist,
  };
}

export function dataPaths(dataDir: string) {
  return {
    dbFile: path.join(dataDir, "nlo.sqlite"),
    jobsDir: path.join(dataDir, "jobs"),
    vaultDir: path.join(dataDir, "vault"),
    vaultKeyFile: path.join(dataDir, "vault.key"),
    tempDir: path.join(dataDir, "tmp"),
  };
}
