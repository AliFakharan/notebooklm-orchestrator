/**
 * SSRF protection. Health checks and any outbound user-influenced request go
 * through `assertAllowedDestination`.
 *
 * Policy:
 *  - only host:port entries in the explicit allowlist are reachable;
 *  - the resolved IP is re-checked (defeats DNS rebinding to private ranges);
 *  - loopback / link-local / private / reserved ranges are NEVER allowed,
 *    even if listed, unless the entry is explicitly marked `allowPrivate`.
 */

export interface AllowEntry {
  /** Exact `host:port` or `host` (port optional -> any port on that host). */
  host: string;
  port?: number;
  /** Explicit opt-in for private destinations (default: never). */
  allowPrivate?: boolean;
}

export class SsrfBlockedError extends Error {
  constructor(
    message: string,
    public readonly reason: string,
  ) {
    super(message);
    this.name = "SsrfBlockedError";
  }
}

/** Classify an IPv4/IPv6 address. Pure, no DNS. */
export function classifyIp(
  ip: string,
): "loopback" | "link_local" | "private" | "reserved" | "public" | "invalid" {
  const v4 = ipTo4(ip);
  if (v4) {
    const [a, b] = v4 as [number, number];
    if (a === 127) return "loopback";
    if (a === 10) return "private";
    if (a === 172 && b >= 16 && b <= 31) return "private";
    if (a === 192 && b === 168) return "private";
    if (a === 169 && b === 254) return "link_local";
    if (a === 0 || a >= 240) return "reserved";
    return "public";
  }
  if (ip === "::1") return "loopback";
  if (ip === "::" || ip === "0:0:0:0:0:0:0:0") return "reserved";
  const v6 = ipTo6(ip);
  if (v6) {
    const a = v6[0] as number;
    const a1 = v6[1] ?? 0;
    if ((a & 0xfe00) === 0xfc00) return "private"; // fc00::/7 ULA
    if ((a & 0xffc0) === 0xfe80) return "link_local"; // fe80::/10
    if (a === 0 && (a1 & 0xff00) === 0) return "reserved"; // ::1 handled, ::/128
    return "public";
  }
  return "invalid";
}

function ipTo4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => {
    if (!/^\d+$/.test(p)) return NaN;
    const n = Number(p);
    return n > 255 ? NaN : n;
  });
  if (nums.some((n) => Number.isNaN(n))) return null;
  return nums;
}

function ipTo6(ip: string): number[] | null {
  if (!ip.includes(":")) return null;
  // Minimal IPv6 normalization for classification.
  try {
    const expanded = expandV6(ip);
    const groups = expanded.split(":").map((g) => parseInt(g, 16));
    if (groups.length !== 8 || groups.some((g) => Number.isNaN(g) || g > 0xffff)) return null;
    return groups;
  } catch {
    return null;
  }
}

function expandV6(ip: string): string {
  const [head, tail] = ip.split("::");
  const h = head ? head.split(":") : [];
  const t = tail ? tail.split(":") : [];
  const fill = 8 - h.length - t.length;
  if (fill < 1) throw new Error("bad v6");
  const all = [...h, ...Array(fill).fill("0"), ...t];
  return all.map((g) => g.padStart(4, "0")).join(":");
}

export interface DestinationCheck {
  /** Original host (as given). */
  host: string;
  /** Resolved IPs (empty if caller did not resolve). */
  ips: string[];
  port: number;
}

/**
 * Assert a destination is allowed.
 * @param dest - the parsed destination (host, port, resolved IPs)
 * @param allowlist - explicit entries from server settings
 * @throws SsrfBlockedError with a machine-readable `reason`
 */
export function assertAllowedDestination(dest: DestinationCheck, allowlist: AllowEntry[]): void {
  const { host, port, ips } = dest;

  const entry = allowlist.find(
    (e) => e.host.toLowerCase() === host.toLowerCase() && (e.port === undefined || e.port === port),
  );
  if (!entry) {
    throw new SsrfBlockedError(
      `destination ${host}:${port} is not in the allowlist`,
      "not_allowed",
    );
  }

  // Always resolve the host when possible; if we have IPs, re-check them.
  const ipsToCheck = ips.length > 0 ? ips : [host];
  for (const ip of ipsToCheck) {
    if (ip.includes(":") || ip.includes(".")) {
      const cls = classifyIp(ip);
      if (cls !== "public" && !(cls === "private" && entry.allowPrivate)) {
        throw new SsrfBlockedError(
          `destination resolves to non-public address (${cls}): ${ip}`,
          "private_target",
        );
      }
    }
  }
}

/**
 * A strict, minimal parser for `host[:port]` allowlist strings.
 * Rejects URLs, query strings, credentials.
 */
export function parseAllowEntry(raw: string): AllowEntry {
  const trimmed = raw.trim();
  if (!trimmed || /[^\w.:[]\s]|\?|#|@|\//.test(trimmed)) {
    throw new Error(`invalid allowlist entry: ${trimmed}`);
  }
  const bracket = trimmed.match(/^\[([^\]]+)\]:(\d+)$/);
  if (bracket) {
    return { host: bracket[1] as string, port: Number(bracket[2]) };
  }
  const lastColon = trimmed.lastIndexOf(":");
  if (lastColon > 0) {
    const host = trimmed.slice(0, lastColon);
    const port = Number(trimmed.slice(lastColon + 1));
    if (!Number.isInteger(port) || port < 1 || port > 65535 || !host) {
      throw new Error(`invalid allowlist entry: ${trimmed}`);
    }
    return { host, port };
  }
  return { host: trimmed };
}
