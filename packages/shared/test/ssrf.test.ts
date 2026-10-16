import { describe, expect, it } from "vitest";
import {
  assertAllowedDestination,
  classifyIp,
  parseAllowEntry,
  SsrfBlockedError,
  type AllowEntry,
} from "../src/ssrf.js";

const ALLOW: AllowEntry[] = [
  { host: "1.1.1.1", port: 443 },
  { host: "check.example.com", port: 443 },
  { host: "10.0.0.5", port: 443, allowPrivate: true },
];

describe("classifyIp", () => {
  it("classifies v4 ranges", () => {
    expect(classifyIp("127.0.0.1")).toBe("loopback");
    expect(classifyIp("10.1.2.3")).toBe("private");
    expect(classifyIp("172.16.0.1")).toBe("private");
    expect(classifyIp("172.32.0.1")).toBe("public");
    expect(classifyIp("192.168.1.1")).toBe("private");
    expect(classifyIp("169.254.169.254")).toBe("link_local"); // cloud metadata
    expect(classifyIp("8.8.8.8")).toBe("public");
    expect(classifyIp("999.1.1.1")).toBe("invalid");
  });

  it("classifies v6 ranges", () => {
    expect(classifyIp("::1")).toBe("loopback");
    expect(classifyIp("fc00::1")).toBe("private");
    expect(classifyIp("fe80::1")).toBe("link_local");
    expect(classifyIp("2001:4860:4860::8888")).toBe("public");
  });
});

describe("assertAllowedDestination", () => {
  it("allows an explicit allowlist entry", () => {
    expect(() =>
      assertAllowedDestination({ host: "1.1.1.1", port: 443, ips: ["1.1.1.1"] }, ALLOW),
    ).not.toThrow();
  });

  it("blocks hosts not in the allowlist", () => {
    expect(() =>
      assertAllowedDestination({ host: "evil.com", port: 443, ips: ["93.184.216.34"] }, ALLOW),
    ).toThrow(SsrfBlockedError);
  });

  it("blocks loopback / metadata even if a naive host looks public", () => {
    // DNS-rebinding style: host allowed by name, but resolves to loopback.
    const allow: AllowEntry[] = [{ host: "foo.example.com" }];
    expect(() =>
      assertAllowedDestination({ host: "foo.example.com", port: 443, ips: ["127.0.0.1"] }, allow),
    ).toThrow(/non-public/);
    expect(() =>
      assertAllowedDestination(
        { host: "foo.example.com", port: 80, ips: ["169.254.169.254"] },
        allow,
      ),
    ).toThrow(SsrfBlockedError);
  });

  it("allows private only when explicitly opted in", () => {
    expect(() =>
      assertAllowedDestination({ host: "10.0.0.5", port: 443, ips: ["10.0.0.5"] }, ALLOW),
    ).not.toThrow();
    const noOptIn: AllowEntry[] = [{ host: "10.0.0.5", port: 443 }];
    expect(() =>
      assertAllowedDestination({ host: "10.0.0.5", port: 443, ips: ["10.0.0.5"] }, noOptIn),
    ).toThrow(SsrfBlockedError);
  });
});

describe("parseAllowEntry", () => {
  it("parses host:port and host-only", () => {
    expect(parseAllowEntry("1.1.1.1:443")).toEqual({ host: "1.1.1.1", port: 443 });
    expect(parseAllowEntry("check.example.com")).toEqual({ host: "check.example.com" });
  });

  it("rejects URLs, credentials, and bad ports", () => {
    expect(() => parseAllowEntry("http://1.1.1.1")).toThrow();
    expect(() => parseAllowEntry("user:pass@1.1.1.1:443")).toThrow();
    expect(() => parseAllowEntry("1.1.1.1:99999")).toThrow();
    expect(() => parseAllowEntry("1.1.1.1?x=1")).toThrow();
  });
});
