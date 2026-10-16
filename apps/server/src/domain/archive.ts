import {
  appendFileSync,
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { safeName, resolveWithin } from "@nlo/shared";

/**
 * Request archive layout (per job, under data/jobs/<job-id>/):
 *
 *   manifest.json
 *   input/prompt.md
 *   input/audio-<safe-name>
 *   execution/timeline.jsonl
 *   execution/attempts.json
 *   execution/errors.json
 *   output/answer.md
 *   output/artifacts/<n>-<safe-name>
 *
 * Security:
 *  - job id is server-generated (validated as `j_<hex>` before use);
 *  - user file names are sanitized (safeName) and NEVER used raw;
 *  - every write is re-verified with resolveWithin(root, ...);
 *  - no secrets are ever written here.
 */

const JOB_ID_RE = /^j_[0-9a-f]{16,64}$/;

export class ArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ArchiveError";
  }
}

export class JobArchive {
  readonly root: string;

  constructor(
    private readonly jobsDir: string,
    private readonly jobId: string,
  ) {
    if (!JOB_ID_RE.test(jobId)) {
      throw new ArchiveError(`invalid job id: ${jobId}`);
    }
    this.root = resolveWithin(jobsDir, jobId);
  }

  private ensureDir(relative: string): string {
    const dir = resolveWithin(this.jobsDir, this.jobId, relative);
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  private writeText(relative: string, content: string): string {
    const file = resolveWithin(this.jobsDir, this.jobId, relative);
    this.ensureDir(path.dirname(relative));
    writeFileSync(file, content, "utf8");
    return file;
  }

  init(input: {
    prompt: string;
    originalAudioName: string | null;
    audioMediaType: string | null;
    configSnapshot: Record<string, unknown>;
    createdAt: string;
  }): void {
    this.ensureDir("input");
    this.ensureDir("execution");
    this.ensureDir("output/artifacts");
    this.writeText("input/prompt.md", input.prompt);
    this.writeText(
      "manifest.json",
      JSON.stringify(
        {
          jobId: this.jobId,
          createdAt: input.createdAt,
          input: {
            promptFile: "input/prompt.md",
            audio: input.originalAudioName
              ? { originalName: input.originalAudioName, mediaType: input.audioMediaType }
              : null,
          },
          configSnapshot: input.configSnapshot,
        },
        null,
        2,
      ),
    );
  }

  /**
   * Store the uploaded audio under a sanitized name.
   * Returns the sanitized file name (original name stays in the manifest).
   */
  async storeAudio(tempFile: string, originalName: string): Promise<string> {
    const safe = safeName(originalName);
    this.ensureDir("input");
    const dest = resolveWithin(this.jobsDir, this.jobId, "input", `audio-${safe}`);
    await new Promise<void>((resolve, reject) => {
      const read = createReadStream(tempFile);
      const write = createWriteStream(dest);
      write.on("finish", () => resolve());
      write.on("error", reject);
      read.on("error", reject);
      read.pipe(write);
    });
    return safe;
  }

  appendTimelineEvent(event: {
    at: string;
    type: string;
    message: string;
    data: Record<string, unknown>;
  }): void {
    const file = resolveWithin(this.jobsDir, this.jobId, "execution", "timeline.jsonl");
    this.ensureDir("execution");
    appendFileSync(file, JSON.stringify(event) + "\n", "utf8");
  }

  writeAttempts(attempts: unknown[]): void {
    this.writeText("execution/attempts.json", JSON.stringify(attempts, null, 2));
  }

  writeErrors(errors: unknown[]): void {
    this.writeText("execution/errors.json", JSON.stringify(errors, null, 2));
  }

  writeAnswer(markdown: string): string {
    return this.writeText("output/answer.md", markdown);
  }

  /**
   * Register a provider artifact. `sourceName` is sanitized; the raw name is
   * kept by the caller in DB/manifest. Returns the safe file name + size.
   */
  storeArtifact(
    sourcePath: string,
    sourceName: string,
    index: number,
  ): { safeName: string; size: number } {
    const safe = safeName(sourceName);
    const safeFileName = `${index}-${safe}`;
    this.ensureDir("output/artifacts");
    const dest = resolveWithin(this.jobsDir, this.jobId, "output", "artifacts", safeFileName);
    copyFileSync(sourcePath, dest);
    const size = statSync(dest).size;
    return { safeName: safeFileName, size };
  }

  manifestPath(): string {
    return resolveWithin(this.jobsDir, this.jobId, "manifest.json");
  }

  exists(): boolean {
    return existsSync(this.root);
  }
}

export function sha256OfFile(file: string): string {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}
