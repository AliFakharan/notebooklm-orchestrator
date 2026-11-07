import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { JobArchive } from "../src/domain/archive.js";

function makeJobsDir(): { jobsDir: string; dispose(): void } {
  const jobsDir = mkdtempSync(path.join(tmpdir(), "nlo-archive-"));
  return { jobsDir, dispose: () => rmSync(jobsDir, { recursive: true, force: true }) };
}

const JOB_ID = "j_" + "ab".repeat(16);

function seededArchive(jobsDir: string): JobArchive {
  const a = new JobArchive(jobsDir, JOB_ID);
  a.init({
    prompt: "p",
    sources: [
      { originalName: "talk.wav", storageName: "1-talk.wav", mediaType: "audio/wav" },
      { originalName: "notes.txt", storageName: "2-notes.txt", mediaType: "text/plain" },
    ],
    configSnapshot: {},
    createdAt: new Date().toISOString(),
  });
  const srcDir = path.join(jobsDir, JOB_ID, "input", "sources");
  writeFileSync(path.join(srcDir, "1-talk.wav"), "wav-bytes");
  writeFileSync(path.join(srcDir, "2-notes.txt"), "txt-bytes");
  return a;
}

describe("JobArchive.deleteSources", () => {
  it("removes every input source and the directory, keeps the rest of the archive", () => {
    const { jobsDir, dispose } = makeJobsDir();
    try {
      const a = seededArchive(jobsDir);
      const removed = a.deleteSources();
      expect(removed).toBe(2);
      expect(existsSync(path.join(a.root, "input", "sources"))).toBe(false);
      expect(existsSync(path.join(a.root, "input", "prompt.md"))).toBe(true);
      expect(existsSync(path.join(a.root, "manifest.json"))).toBe(true);
    } finally {
      dispose();
    }
  });

  it("is a no-op (returns 0) when there is no sources directory", () => {
    const { jobsDir, dispose } = makeJobsDir();
    try {
      const a = new JobArchive(jobsDir, "j_" + "cd".repeat(16));
      expect(a.deleteSources()).toBe(0);
    } finally {
      dispose();
    }
  });
});
