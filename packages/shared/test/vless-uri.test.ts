import { describe, expect, it } from "vitest";
import {
  buildVlessUri,
  maskUuid,
  parseVlessUri,
  redactVlessUri,
  VlessUriError,
} from "../src/vless-uri.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("parseVlessUri", () => {
  it("parses a basic tcp/none URI", () => {
    const { config, warnings } = parseVlessUri(`vless://${UUID}@example.com:443`);
    expect(config.server).toBe("example.com");
    expect(config.port).toBe(443);
    expect(config.uuidSecretRef).toBe(`vless-uuid:${UUID}`);
    expect(config.transport).toBe("tcp");
    expect(config.security).toBe("none");
    expect(config.name).toBe("example.com:443");
    expect(warnings).toHaveLength(0);
  });

  it("parses ws + tls + sni with percent-encoded values", () => {
    const uri = `vless://${UUID}@example.com:443?type=ws&security=tls&sni=cdn.example.com&host=cdn.example.com&path=%2Fabc%20def&encryption=none#My%20Node`;
    const { config } = parseVlessUri(uri);
    expect(config.transport).toBe("ws");
    expect(config.security).toBe("tls");
    expect(config.sni).toBe("cdn.example.com");
    expect(config.wsHost).toBe("cdn.example.com");
    expect(config.wsPath).toBe("/abc def"); // percent-decoded correctly
    expect(config.name).toBe("My Node");
  });

  it("requires a path for ws transport", () => {
    expect(() => parseVlessUri(`vless://${UUID}@example.com:443?type=ws`)).toThrow(VlessUriError);
  });

  it("requires pbk/sid/sni for reality", () => {
    expect(() => parseVlessUri(`vless://${UUID}@example.com:443?security=reality`)).toThrow(/pbk/);
  });

  it("preserves unknown parameters instead of dropping them", () => {
    const { config, warnings } = parseVlessUri(`vless://${UUID}@example.com:443?customFlag=123`);
    expect(config.extra).toEqual({ customFlag: "123" });
    expect(warnings.join(" ")).toContain("customFlag");
  });

  it("rejects malformed URIs and bad UUIDs", () => {
    expect(() => parseVlessUri("not a uri")).toThrow(VlessUriError);
    expect(() => parseVlessUri(`vless://no-uuid@example.com:443`)).toThrow(/UUID/);
    expect(() => parseVlessUri(`http://${UUID}@example.com:443`)).toThrow(/scheme/);
    // Out-of-range port is rejected by the URL parser ("malformed") — still a VlessUriError.
    expect(() => parseVlessUri(`vless://${UUID}@example.com:99999`)).toThrow(VlessUriError);
    // Missing port is rejected by our validator.
    expect(() => parseVlessUri(`vless://${UUID}@example.com`)).toThrow(/port/);
  });

  it("rejects invalid percent-encoding", () => {
    expect(() => parseVlessUri(`vless://${UUID}@example.com:443#bad%zz`)).toThrow(
      /percent-encoding/,
    );
  });

  it("round-trips through buildVlessUri", () => {
    const original = `vless://${UUID}@example.com:443?type=ws&security=tls&sni=s.example.com&host=h.example.com&path=%2Fp#N1`;
    const { config } = parseVlessUri(original);
    const rebuilt = buildVlessUri(config, UUID);
    const { config: c2 } = parseVlessUri(rebuilt);
    expect(c2).toEqual(config);
  });
});

describe("masking / redaction", () => {
  it("masks a UUID keeping only the last 4 chars", () => {
    expect(maskUuid(UUID)).toBe("••••-••••-••••-5555");
    expect(maskUuid("garbage")).toBe("••••");
  });

  it("redacts a full URI without leaking the UUID", () => {
    const redacted = redactVlessUri(`vless://${UUID}@example.com:443#n`);
    expect(redacted).not.toContain(UUID);
    expect(redacted).toContain("5555");
    expect(redacted).toContain("@example.com:443");
  });
});
