import type { ProxyNodeConfig, ProxySecurity, ProxyTransport } from "./types.js";

/**
 * VLESS URI parsing and masking.
 *
 * Format: vless://<uuid>@<server>:<port>?<params>#<name>
 *
 * Rules:
 *  - percent-encoded values are decoded correctly;
 *  - malformed URIs are rejected with a descriptive error (never swallowed);
 *  - unknown parameters are preserved in `extra` (not silently dropped);
 *  - required combinations are validated per transport/security;
 *  - UUIDs are masked everywhere except the initial submission.
 */

export class VlessUriError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VlessUriError";
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const KNOWN_PARAMS = new Set([
  "type",
  "security",
  "sni",
  "host",
  "path",
  "pbk",
  "sid",
  "spx",
  "flow",
  "encryption",
  "alpn",
]);

/** Mask a UUID for display/logs: keep only the last 4 chars. */
export function maskUuid(uuid: string): string {
  if (!UUID_RE.test(uuid)) return "••••";
  return `••••-••••-••••-${uuid.slice(-4)}`;
}

/**
 * Redact a full VLESS URI for logs/errors: replaces the credential portion
 * with a masked UUID. Never returns the raw UUID.
 */
export function redactVlessUri(uri: string): string {
  try {
    const at = uri.indexOf("@");
    const schemeEnd = uri.indexOf("://");
    if (at <= 0 || schemeEnd < 0) return "vless://[redacted]";
    const prefix = uri.slice(0, schemeEnd + 3);
    const uuid = uri.slice(schemeEnd + 3, at);
    const rest = uri.slice(at);
    return `${prefix}${maskUuid(uuid)}${rest}`;
  } catch {
    return "vless://[redacted]";
  }
}

export interface ParsedVlessUri {
  config: ProxyNodeConfig;
  warnings: string[];
}

function parsePort(raw: string | null): number {
  if (raw === null || raw === "") throw new VlessUriError("port is missing");
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new VlessUriError(`invalid port: ${raw}`);
  }
  return port;
}

function pick(query: URLSearchParams, key: string): string | undefined {
  const value = query.get(key);
  if (value === null) return undefined;
  return value.length > 0 ? value : undefined;
}

/** Parse and validate a VLESS URI. Throws VlessUriError on any problem. */
export function parseVlessUri(uri: string): ParsedVlessUri {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    throw new VlessUriError("malformed URI");
  }

  if (parsed.protocol !== "vless:") {
    throw new VlessUriError(`unsupported scheme: ${parsed.protocol}`);
  }

  const uuid = decodeURIComponentSafe(parsed.username);
  if (!UUID_RE.test(uuid)) {
    throw new VlessUriError("missing or invalid UUID credential");
  }

  const server = parsed.hostname;
  if (!server) {
    throw new VlessUriError("server host is missing");
  }

  const port = parsePort(parsed.port);
  const warnings: string[] = [];

  const query = parsed.searchParams;
  const config: ProxyNodeConfig = {
    name: decodeURIComponentSafe(parsed.hash.replace(/^#/, "")) || `${server}:${port}`,
    server,
    port,
    uuidSecretRef: `vless-uuid:${uuid}`,
    transport: "tcp",
    security: "none",
    extra: {},
  };

  const transport = pick(query, "type") ?? "tcp";
  if (!["tcp", "ws", "grpc"].includes(transport)) {
    throw new VlessUriError(`unsupported transport type: ${transport}`);
  }
  config.transport = transport as ProxyTransport;

  const security = pick(query, "security") ?? "none";
  if (!["none", "tls", "reality"].includes(security)) {
    throw new VlessUriError(`unsupported security mode: ${security}`);
  }
  config.security = security as ProxySecurity;

  config.sni = pick(query, "sni");
  config.wsHost = pick(query, "host");
  config.wsPath = pick(query, "path");
  config.pbk = pick(query, "pbk");
  config.sid = pick(query, "sid");
  config.spx = pick(query, "spx");
  config.flow = pick(query, "flow");
  config.encryption = pick(query, "encryption") ?? "none";
  config.alpn = pick(query, "alpn");

  // Preserve unknown parameters (never silently drop meaningful params).
  for (const [key, value] of query.entries()) {
    if (!KNOWN_PARAMS.has(key)) {
      config.extra[key] = value;
      warnings.push(`unknown parameter preserved: ${key}`);
    }
  }

  validateCombination(config, warnings);

  return { config, warnings };
}

function validateCombination(config: ProxyNodeConfig, warnings: string[]): void {
  if (config.transport === "ws") {
    if (!config.wsPath) {
      throw new VlessUriError("ws transport requires a path parameter");
    }
    if (!config.wsHost) {
      warnings.push("ws transport without host header (SNI may mismatch)");
    }
  }
  if (config.security === "tls" && !config.sni) {
    warnings.push("tls without sni: will fall back to server host");
  }
  if (config.security === "reality") {
    if (!config.pbk) throw new VlessUriError("reality requires pbk (public key)");
    if (!config.sid) throw new VlessUriError("reality requires sid (short id)");
    if (!config.sni) throw new VlessUriError("reality requires sni");
  }
  if (config.security === "none" && config.transport !== "tcp") {
    warnings.push(`security none with ${config.transport} transport is unusual`);
  }
}

function decodeURIComponentSafe(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    // Invalid percent-encoding -> reject, do not silently drop.
    throw new VlessUriError("invalid percent-encoding in URI");
  }
}

/**
 * Build a VLESS URI from a normalized config + UUID.
 * Used for import/export round-trips and tests.
 */
export function buildVlessUri(config: ProxyNodeConfig, uuid: string): string {
  const params = new URLSearchParams();
  if (config.transport !== "tcp") params.set("type", config.transport);
  if (config.security !== "none") params.set("security", config.security);
  if (config.sni) params.set("sni", config.sni);
  if (config.wsHost) params.set("host", config.wsHost);
  if (config.wsPath) params.set("path", config.wsPath);
  if (config.pbk) params.set("pbk", config.pbk);
  if (config.sid) params.set("sid", config.sid);
  if (config.spx) params.set("spx", config.spx);
  if (config.flow) params.set("flow", config.flow);
  if (config.encryption && config.encryption !== "none")
    params.set("encryption", config.encryption);
  if (config.alpn) params.set("alpn", config.alpn);
  for (const [k, v] of Object.entries(config.extra)) params.set(k, v);

  const base = `vless://${uuid}@${config.server}:${config.port}`;
  const q = params.toString();
  const hash = encodeURIComponent(config.name);
  return `${base}${q ? `?${q}` : ""}#${hash}`;
}
