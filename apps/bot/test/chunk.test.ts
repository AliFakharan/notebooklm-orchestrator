import { describe, expect, it } from "vitest";
import { BALE_MESSAGE_CHUNK_MAX, chunkText } from "../src/bale.js";

describe("chunkText", () => {
  it("returns a single chunk for short text", () => {
    expect(chunkText("سلام")).toEqual(["سلام"]);
  });

  it("returns [] for empty text", () => {
    expect(chunkText("")).toEqual([]);
  });

  it("splits on newlines, never exceeds max, and rejoins exactly", () => {
    const lines = [
      "# عنوان",
      "",
      "سطر اول",
      "سطر دوم با متنی بلند‌تر از حد کوتاه",
      ...Array.from({ length: 200 }, (_, i) => `خط ${i} ${"x".repeat(20)}`),
    ];
    const text = lines.join("\n");
    const chunks = chunkText(text, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("\n")).toBe(text);
  });

  it("hard-splits a single line longer than max without losing characters", () => {
    const text = "y".repeat(10_000);
    const chunks = chunkText(text, 4000);
    expect(chunks.map((c) => c.length)).toEqual([4000, 4000, 2000]);
    expect(chunks.join("").length).toBe(10_000);
  });

  it("handles a mix of long and short lines", () => {
    const long = "z".repeat(5000);
    const text = `intro\n${long}\ntail`;
    const chunks = chunkText(text, 1000);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(1000);
    const stripped = (s: string): string => s.replace(/\n/g, "");
    expect(stripped(chunks.join("\n"))).toBe(stripped(text));
  });

  it("handles whitespace-only text", () => {
    expect(chunkText("\n", 5)).toEqual(["\n"]);
  });

  it("respects the default 4000-char chunk max", () => {
    const text = ["a\n" + "b".repeat(1999), "c".repeat(3900)].join("\n");
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(BALE_MESSAGE_CHUNK_MAX);
  });

  it("rejects an invalid max", () => {
    expect(() => chunkText("ab", 0)).toThrow();
  });
});
