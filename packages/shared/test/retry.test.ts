import { describe, expect, it } from "vitest";
import { backoffMs, classifyError, isRetryableError } from "../src/retry.js";

describe("classifyError", () => {
  it("classifies auth, rate limit, connectivity, and provider", () => {
    expect(classifyError("401 Unauthorized", 401)).toBe("auth");
    expect(classifyError("sid expired", 403)).toBe("auth");
    expect(classifyError("Too Many Requests", 429)).toBe("rate_limit");
    expect(classifyError("ECONNRESET", undefined)).toBe("connectivity");
    expect(classifyError("fetch failed: DNS error", undefined)).toBe("connectivity");
    expect(classifyError("internal error", 500)).toBe("provider");
  });

  it("treats ambiguous completion as a special class", () => {
    expect(classifyError("worker died: unknown completion", undefined)).toBe("ambiguous");
  });

  it("defaults unrecognized errors to unknown (not retried)", () => {
    expect(classifyError("something weird", undefined)).toBe("unknown");
  });
});

describe("isRetryableError", () => {
  it("retries only transient classes", () => {
    expect(isRetryableError("rate_limit")).toBe(true);
    expect(isRetryableError("connectivity")).toBe(true);
    expect(isRetryableError("proxy")).toBe(true);
    expect(isRetryableError("provider")).toBe(true);
  });
  it("never auto-retries auth, invalid input, ambiguous, unknown", () => {
    expect(isRetryableError("auth")).toBe(false);
    expect(isRetryableError("invalid_input")).toBe(false);
    expect(isRetryableError("ambiguous")).toBe(false);
    expect(isRetryableError("unknown")).toBe(false);
  });
});

describe("backoffMs", () => {
  it("is deterministic with a fixed rng and grows with attempts", () => {
    const fixed = () => 0.5;
    const a1 = backoffMs(1, { baseMs: 1000, capMs: 60000, rng: fixed });
    const a2 = backoffMs(2, { baseMs: 1000, capMs: 60000, rng: fixed });
    const a3 = backoffMs(3, { baseMs: 1000, capMs: 60000, rng: fixed });
    expect(a1).toBeLessThan(a2);
    expect(a2).toBeLessThan(a3);
  });

  it("caps at the maximum", () => {
    const out = backoffMs(20, { baseMs: 1000, capMs: 5000, rng: () => 1 });
    expect(out).toBeLessThanOrEqual(5000);
  });
});
