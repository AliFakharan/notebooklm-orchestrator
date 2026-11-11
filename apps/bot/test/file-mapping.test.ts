import { describe, expect, it } from "vitest";
import { mapAttachment, pickLargestPhoto } from "../src/flow.js";

const MAX = 100 * 1024 * 1024;

describe("mapAttachment", () => {
  it("keeps a document file name (sanitized) and derives a content type", () => {
    expect(mapAttachment("document", { file_name: "report.pdf" }, MAX)).toEqual({
      filename: "report.pdf",
      contentType: "application/pdf",
    });
  });

  it("sanitizes weird document names", () => {
    const r = mapAttachment("document", { file_name: "my report (1).pdf" }, MAX);
    if ("error" in r) throw new Error("expected ok");
    expect(r.filename.endsWith(".pdf")).toBe(true);
    expect(r.filename).not.toContain(" ");
  });

  it("rejects unsupported document extensions / missing names", () => {
    expect(mapAttachment("document", { file_name: "virus.exe" }, MAX)).toEqual({ error: "unsupportedType" });
    expect(mapAttachment("document", { file_name: "noext" }, MAX)).toEqual({ error: "unsupportedType" });
    expect(mapAttachment("document", { file_size: 10 }, MAX)).toEqual({ error: "unsupportedType" });
  });

  it("maps photos to .jpg and voice to .ogg", () => {
    expect(mapAttachment("photo", { file_id: "x", file_size: 10 }, MAX, 123)).toEqual({
      filename: "photo-123.jpg",
      contentType: "image/jpeg",
    });
    expect(mapAttachment("voice", { file_id: "x", file_size: 10 }, MAX, 123)).toEqual({
      filename: "voice-123.ogg",
      contentType: "audio/ogg",
    });
  });

  it("keeps allowed audio/video extensions, rejects others", () => {
    expect(mapAttachment("audio", { file_name: "song.mp3", mime_type: "audio/mpeg" }, MAX, 5)).toEqual({
      filename: "song.mp3",
      contentType: "audio/mpeg",
    });
    expect(mapAttachment("video", { file_name: "clip.mp4" }, MAX, 5)).toEqual({
      filename: "clip.mp4",
      contentType: "video/mp4",
    });
    expect(mapAttachment("audio", { file_name: "weird.xyz" }, MAX)).toEqual({ error: "unsupportedType" });
    expect(mapAttachment("video", { file_name: "weird.xyz" }, MAX)).toEqual({ error: "unsupportedType" });
  });

  it("derives a name from the mime type when audio/video has no file name", () => {
    expect(mapAttachment("audio", { mime_type: "audio/mpeg" }, MAX, 9)).toEqual({
      filename: "audio-9.mp3",
      contentType: "audio/mpeg",
    });
    expect(mapAttachment("video", { mime_type: "video/unknown" }, MAX, 9)).toEqual({
      error: "unsupportedType",
    });
  });

  it("pre-checks the size against the cap (100 MB)", () => {
    expect(mapAttachment("document", { file_name: "big.pdf", file_size: MAX }, MAX)).not.toEqual({
      error: "tooLarge",
    });
    expect(mapAttachment("document", { file_name: "big.pdf", file_size: MAX + 1 }, MAX)).toEqual({
      error: "tooLarge",
    });
  });
});

describe("pickLargestPhoto", () => {
  it("picks the largest by file_size, falling back to width*height", () => {
    const bySize = pickLargestPhoto([
      { file_id: "a", file_size: 100 },
      { file_id: "b", file_size: 500 },
      { file_id: "c", file_size: 300 },
    ]);
    expect(bySize.file_id).toBe("b");

    const byArea = pickLargestPhoto([
      { file_id: "a", width: 100, height: 100 },
      { file_id: "b", width: 200, height: 150 },
    ]);
    expect(byArea.file_id).toBe("b");
  });

  it("throws on an empty list", () => {
    expect(() => pickLargestPhoto([])).toThrow();
  });
});
