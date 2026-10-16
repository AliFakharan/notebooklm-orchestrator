import { describe, expect, it } from "vitest";
import { redactDeep, redactSecrets } from "../src/redaction.js";

const UUID = "11111111-2222-4333-8444-555555555555";

describe("redactSecrets", () => {
  it("redacts full VLESS URIs", () => {
    const out = redactSecrets(`connecting via vless://${UUID}@ex.com:443#n done`);
    expect(out).not.toContain(UUID);
    expect(out).toContain("vless://[REDACTED]");
  });

  it("redacts bare UUIDs", () => {
    const out = redactSecrets(`uuid ${UUID} used`);
    expect(out).not.toContain(UUID);
  });

  it("redacts cookie and bearer values", () => {
    expect(redactSecrets("SID=abc123secret; HSID=xyz")).not.toContain("abc123secret");
    expect(redactSecrets("Authorization: Bearer abcdefghijklmnopqrstuvwx")).toBe(
      "Authorization: bearer [REDACTED]",
    );
  });

  it("is a no-op on clean text", () => {
    expect(redactSecrets("job succeeded in 120ms")).toBe("job succeeded in 120ms");
  });
});

describe("redactDeep", () => {
  it("recurses into objects and arrays", () => {
    const input = {
      msg: `vless://${UUID}@ex.com:443`,
      nested: { list: [`token=supersecretvalue`, "fine"] },
      num: 5,
    };
    const out = redactDeep(input) as typeof input;
    expect(out.msg).toContain("[REDACTED]");
    expect(out.nested.list[0]).toContain("[REDACTED]");
    expect(out.nested.list[1]).toBe("fine");
    expect(out.num).toBe(5);
  });
});
