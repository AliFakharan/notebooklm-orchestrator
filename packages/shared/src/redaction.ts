/**
 * Log/response redaction. Applied to ALL logs and error payloads before they
 * are persisted or returned. Patterns target credentials we handle:
 * full VLESS URIs, UUIDs, cookie headers, password-like fields, SID tokens.
 */

const VLESS_URI_RE = /vless:\/\/[^\s"'<>]+/gi;
const UUID_RE = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const COOKIE_HEADER_RE = /(?:set-)?-?\s?cookie\s*[:=]\s*([^,;\n]+)/gi;
const KV_SECRET_RE =
  /([Cc]ookie|[Pp]assword|[Pp]ass|[Tt]oken|SID|HSID|SSID|APISID|SAPISID|OSID|SAPISIDHASH|__Secure-[A-Z0-9]+)\s*[:=]\s*("[^"]*"|'[^']*'|[^\s,;]+)/gi;
const BEARER_RE = /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/gi;

/**
 * Redact a string for safe logging/display.
 * - full VLESS URIs -> `vless://[REDACTED]`
 * - bare UUIDs -> first 4 + `…`
 * - cookie/password/token values -> `[REDACTED]`
 */
export function redactSecrets(input: string): string {
  if (!input) return input;
  return input
    .replace(VLESS_URI_RE, "vless://[REDACTED]")
    .replace(UUID_RE, (m) => `${m.slice(0, 4)}…`)
    .replace(COOKIE_HEADER_RE, "cookie=[REDACTED]")
    .replace(KV_SECRET_RE, "$1=[REDACTED]")
    .replace(BEARER_RE, "bearer [REDACTED]");
}

/** Recursively redact string values inside a JSON-able object. */
export function redactDeep<T>(value: T): T {
  if (typeof value === "string") {
    return redactSecrets(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => redactDeep(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactDeep(v);
    }
    return out as T;
  }
  return value;
}
