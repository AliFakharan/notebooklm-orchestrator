import { describe, expect, it } from "vitest";
import { resolveWithin, safeName } from "../src/safe-name.js";

describe("safeName", () => {
  it("keeps a simple name", () => {
    expect(safeName("interview.mp3")).toBe("interview.mp3");
  });

  it("takes only the basename (no traversal can survive)", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("..\\..\\windows\\system32")).toBe("system32");
    expect(safeName("a/b/c.txt")).toBe("c.txt");
  });

  it("strips null bytes and normalizes odd chars", () => {
    expect(safeName("a\0b.mp3")).toBe("ab.mp3");
    const persian = safeName("فايل صوتی.mp3");
    expect(persian).toMatch(/^_+\.mp3$/); // non-ascii (incl. space) -> _
    expect(safeName("  spaces  ")).toBe("__spaces__");
  });

  it("caps length and avoids leading/trailing dots", () => {
    expect(safeName("a".repeat(500) + ".wav")).toHaveLength(80);
    expect(safeName(".hidden")).toBe("_hidden");
    expect(safeName("trailing....")).toBe("trailing");
  });

  it("throws on empty/traversal-only results", () => {
    expect(() => safeName("")).toThrow();
    expect(() => safeName("...")).toThrow();
    expect(() => safeName("///")).toThrow();
  });
});

describe("resolveWithin", () => {
  it("resolves inside the root", () => {
    expect(resolveWithin("/data/jobs", "abc", "input", "prompt.md")).toBe(
      "/data/jobs/abc/input/prompt.md",
    );
  });

  it("throws on traversal out of the root", () => {
    expect(() => resolveWithin("/data/jobs", "abc", "../../etc/passwd")).toThrow(/escapes root/);
  });
});
