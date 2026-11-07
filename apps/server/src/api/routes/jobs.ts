import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes, MAX_SOURCES_PER_JOB, safeName, type JobSource } from "@nlo/shared";
import { resolveWithin } from "@nlo/shared/resolve-within";
import type { AppContext } from "../../app-context.js";
import { JobArchive } from "../../domain/archive.js";
import { dataPaths } from "../../config.js";

const listQuery = z.object({
  status: z.string().optional(),
  accountId: z.string().optional(),
  nodeId: z.string().optional(),
  search: z.string().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

/** Extension -> media type fallback (when the client sends no usable mime). */
const EXT_MEDIA: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  epub: "application/epub+zip",
  avif: "image/avif",
  bmp: "image/bmp",
  gif: "image/gif",
  heic: "image/heic",
  heif: "image/heif",
  ico: "image/x-icon",
  jp2: "image/jp2",
  jpe: "image/jpeg",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  png: "image/png",
  tif: "image/tiff",
  tiff: "image/tiff",
  webp: "image/webp",
  "3g2": "audio/3gpp2",
  "3gp": "video/3gpp",
  aac: "audio/aac",
  aif: "audio/aiff",
  aifc: "audio/aiff",
  aiff: "audio/aiff",
  amr: "audio/amr",
  au: "audio/basic",
  avi: "video/avi",
  cda: "audio/x-cdrom-audio",
  m4a: "audio/mp4",
  mid: "audio/midi",
  mp3: "audio/mpeg",
  mp4: "video/mp4",
  mpeg: "video/mpeg",
  ogg: "audio/ogg",
  opus: "audio/opus",
  ra: "audio/vnd.rn-realaudio",
  ram: "audio/x-pn-realaudio",
  snd: "audio/basic",
  wav: "audio/wav",
  wma: "audio/x-ms-wma",
};

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Create a job: multipart with field prompt and 0..N file parts (any
  // NotebookLM-permitted format). The Google account is chosen automatically
  // (the default account, else the most recently successful eligible one) —
  // there is no per-job account/proxy selection.
  app.post("/api/jobs", async (req, reply) => {
    const fields: Record<string, string> = {};
    // The multipart iterator only advances past a file part once its stream is
    // consumed, so we MUST drain each file stream INSIDE the loop (to a temp
    // file) or the request hangs forever. More than MAX_SOURCES_PER_JOB files
    // are rejected with a clear validation error.
    const uploads: { filename: string; type: string; tempPath: string }[] = [];
    let droppedFiles = 0;

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (uploads.length >= MAX_SOURCES_PER_JOB) {
            await drainStream(part.file);
            droppedFiles++;
            continue;
          }
          const tempPath = await saveMultipartToTemp(ctx, part.file);
          uploads.push({
            filename: part.filename ?? "upload",
            type: part.mimetype ?? "",
            tempPath,
          });
        } else if (part.fieldname) {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      await rmAll(uploads.map((u) => u.tempPath));
      throw err;
    }

    const prompt = (fields.prompt ?? "").trim();
    if (!prompt) {
      await rmAll(uploads.map((u) => u.tempPath));
      throw new ApiError(ApiCodes.validation, "prompt is required", 400);
    }

    // Account + proxy are chosen automatically at run time: the runner
    // prefers the default account (then the most recently successful eligible
    // one) and picks the healthiest enabled proxy. Reject only when there is
    // NO account at all (clearer than a runner failure later); the runner
    // re-checks eligibility + a live verified session.
    const title = (fields.title ?? "").trim() || null;
    if (ctx.accounts.list().length === 0) {
      await rmAll(uploads.map((u) => u.tempPath));
      throw new ApiError(
        ApiCodes.validation,
        "no google account is registered; add one in the admin panel first",
        400,
      );
    }

    if (droppedFiles > 0) {
      await rmAll(uploads.map((u) => u.tempPath));
      throw new ApiError(ApiCodes.validation, `too many files (max ${MAX_SOURCES_PER_JOB})`, 400);
    }

    // Validate + hash each source. `storageName` is index-prefixed so two
    // files with the same (or the same sanitized) name never collide.
    const { sha256OfFile } = await import("../../domain/archive.js");
    const sources: JobSource[] = [];
    try {
      for (let i = 0; i < uploads.length; i++) {
        const up = uploads[i];
        if (!up) continue;
        const ext = path.extname(up.filename).toLowerCase().replace(/^\./, "");
        if (!ctx.config.allowedSourceExtensions.includes(ext)) {
          throw new ApiError(
            ApiCodes.validation,
            `unsupported file type: .${ext || "(no extension)"}`,
            400,
          );
        }
        const size = await sizeOf(up.tempPath);
        if (size === 0) {
          throw new ApiError(ApiCodes.validation, `file "${up.filename}" is empty`, 400);
        }
        if (size > ctx.config.maxUploadBytes) {
          throw new ApiError(ApiCodes.validation, `file "${up.filename}" exceeds size limit`, 413);
        }
        let safe: string;
        try {
          safe = safeName(up.filename);
        } catch {
          safe = `file${ext ? `.${ext}` : ""}`;
        }
        sources.push({
          originalName: up.filename,
          storageName: `${i + 1}-${safe}`,
          mediaType: up.type || EXT_MEDIA[ext] || "application/octet-stream",
          size,
          sha256: sha256OfFile(up.tempPath),
          // The extension list IS NotebookLM's official supported set, so any
          // accepted file is provider-confirmed by definition.
          providerConfirmed: true,
        });
      }
    } catch (err) {
      await rmAll(uploads.map((u) => u.tempPath));
      throw err;
    }

    const job = ctx.jobs.create({
      input: {
        prompt,
        title,
        sources,
        preferredAccountId: null,
        preferredNodeId: null,
      },
      configSnapshot: {
        provider: ctx.provider.name,
        proxyRuntime: ctx.config.proxyRuntime,
        host: ctx.config.host,
      },
    });

    // Initialize the archive and store every source under its storage name.
    try {
      const archive = new JobArchive(dataPaths(ctx.config.dataDir).jobsDir, job.id);
      archive.init({
        prompt,
        sources: sources.map((s) => ({
          originalName: s.originalName,
          storageName: s.storageName,
          mediaType: s.mediaType,
        })),
        configSnapshot: job.configSnapshot,
        createdAt: job.createdAt,
      });
      for (let i = 0; i < uploads.length; i++) {
        const up = uploads[i];
        const src = sources[i];
        if (!up || !src) continue;
        await archive.storeSource(up.tempPath, src.storageName);
      }
      ctx.jobs.appendEvent(job.id, "created", "job created and queued");
    } catch {
      // Roll back: fail the job, do not leak the raw error.
      ctx.jobs.setStatus(job.id, "FAILED", {
        errorClass: "invalid_input",
        errorMessage: "archive initialization failed",
      });
      throw new ApiError(ApiCodes.validation, "could not store request", 400);
    } finally {
      // The temp uploads are copied into the archive; drop the temp copies.
      await rmAll(uploads.map((u) => u.tempPath));
    }

    return reply.code(201).send({ id: job.id, status: job.status });
  });

  // List with filters + pagination.
  app.get("/api/jobs", async (req) => {
    const q = listQuery.parse(req.query);
    const status = q.status
      ? (q.status.split(",") as import("@nlo/shared").JobStatus[])
      : undefined;
    return ctx.jobs.list({
      status,
      accountId: q.accountId,
      nodeId: q.nodeId,
      search: q.search,
      limit: q.limit,
      offset: q.offset,
    });
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return job;
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/events", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return ctx.jobs.events(job.id);
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/attempts", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    return ctx.jobs.attempts(job.id);
  });

  app.get<{ Params: { id: string } }>("/api/jobs/:id/artifacts", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    const rows = (ctx.jobs as unknown as { db: { raw: import("node:sqlite").DatabaseSync } }).db.raw
      .prepare(
        "SELECT id, filename, media_type, size, source, storage_key, created_at FROM artifacts WHERE job_id = ? ORDER BY id",
      )
      .all(job.id) as Record<string, unknown>[];
    return rows.map((r) => ({
      id: r.id as string,
      filename: r.filename as string,
      mediaType: r.media_type as string,
      size: r.size as number,
      source: r.source as string,
      storageKey: r.storage_key as string,
      createdAt: r.created_at as string,
    }));
  });

  // Download a single artifact (safe: storage_key is server-assigned).
  app.get<{ Params: { id: string; artifactId: string } }>(
    "/api/jobs/:id/artifacts/:artifactId",
    async (req, reply) => {
      const job = ctx.jobs.get(req.params.id);
      if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
      const art = (
        ctx.jobs as unknown as { db: { raw: import("node:sqlite").DatabaseSync } }
      ).db.raw
        .prepare("SELECT * FROM artifacts WHERE id = ? AND job_id = ?")
        .get(req.params.artifactId, job.id) as Record<string, unknown> | undefined;
      if (!art) throw new ApiError(ApiCodes.notFound, "artifact not found", 404);

      const { createReadStream, statSync } = await import("node:fs");
      const storageKey = art.storage_key as string;
      const file = resolveWithin(dataPaths(ctx.config.dataDir).jobsDir, job.id, storageKey);
      const stat = statSync(file);
      reply.header("content-type", art.media_type as string);
      reply.header("content-length", stat.size);
      reply.header(
        "content-disposition",
        `attachment; filename="${encodeURIComponent(art.filename as string)}"`,
      );
      return reply.send(createReadStream(file));
    },
  );

  // Stream one of the job's INPUT sources back to the web (player/download).
  // The file is server-stored at data/jobs/<id>/input/sources/<storageName>;
  // the index selects within the job's own recorded sources, and resolveWithin
  // keeps the path inside the job dir, so no client-controlled path component
  // exists. `download=1` switches to attachment disposition.
  app.get<{ Params: { id: string; index: string }; Querystring: { download?: string } }>(
    "/api/jobs/:id/sources/:index",
    async (req, reply) => {
      const job = ctx.jobs.get(req.params.id);
      if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
      const idx = Number(req.params.index);
      const src =
        Number.isInteger(idx) && idx >= 1 && idx <= job.input.sources.length
          ? job.input.sources[idx - 1]
          : null;
      if (!src) {
        throw new ApiError(ApiCodes.notFound, "source not found", 404);
      }
      const { createReadStream, statSync } = await import("node:fs");
      // New layout: input/sources/<storageName>. Legacy jobs (pre multi-source)
      // stored the single audio at input/audio-<safeName(originalName)>; fall
      // back to it so old jobs still serve their file.
      const jobsDir = dataPaths(ctx.config.dataDir).jobsDir;
      let legacyName = "";
      try {
        legacyName = `audio-${safeName(src.originalName)}`;
      } catch {
        legacyName = `audio-${src.originalName}`;
      }
      const candidates = [
        resolveWithin(jobsDir, job.id, "input", "sources", src.storageName),
        resolveWithin(jobsDir, job.id, "input", legacyName),
      ];
      let file = "";
      let stat;
      for (const c of candidates) {
        try {
          stat = statSync(c);
          file = c;
          break;
        } catch {
          /* try next candidate */
        }
      }
      if (!stat || !file) {
        throw new ApiError(ApiCodes.notFound, "source file missing", 404);
      }
      const disposition = req.query.download
        ? `attachment; filename="${encodeURIComponent(src.originalName)}"`
        : `inline; filename="${encodeURIComponent(src.originalName)}"`;
      reply.header("content-type", src.mediaType);
      reply.header("content-length", stat.size);
      reply.header("content-disposition", disposition);
      return reply.send(createReadStream(file));
    },
  );

  app.post<{ Params: { id: string } }>("/api/jobs/:id/cancel", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    // Terminal: nothing to do.
    if (["SUCCEEDED", "FAILED", "CANCELLED"].includes(job.status)) {
      return { ok: true, cancelled: false, status: job.status, note: "already terminal" };
    }
    if (job.status === "RUNNING") {
      // Only RUNNING requests cancel; the runner finalizes CANCELLED.
      ctx.jobs.setStatus(job.id, "CANCEL_REQUESTED");
      const aborted = ctx.runner.cancel(job.id);
      return { ok: true, cancelled: aborted, status: "CANCEL_REQUESTED" };
    }
    // Other in-flight / pending states may go straight to CANCELLED.
    if (
      [
        "CREATED",
        "VALIDATING",
        "QUEUED",
        "WAITING_FOR_ACCOUNT",
        "WAITING_FOR_PROXY",
        "RETRY_WAIT",
        "NEEDS_ATTENTION",
      ].includes(job.status)
    ) {
      ctx.jobs.setStatus(job.id, "CANCELLED", { errorMessage: "cancelled by user" });
      ctx.jobs.appendEvent(job.id, "cancelled", "job cancelled");
      return { ok: true, cancelled: true, status: "CANCELLED" };
    }
    throw new ApiError(ApiCodes.invalidState, "job cannot be cancelled in this state", 409);
  });

  // Re-queue a job (operator action):
  //  - NEEDS_ATTENTION: human reconciliation (attempt budget preserved);
  //  - FAILED: explicit retry with the SAME account + inputs; the attempt
  //    budget is reset, the stale error and last node selection are cleared,
  //    and the runner re-validates the session and picks a FRESH proxy.
  app.post<{ Params: { id: string } }>("/api/jobs/:id/requeue", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    if (job.status === "NEEDS_ATTENTION") {
      ctx.jobs.setStatus(job.id, "QUEUED");
      ctx.jobs.appendEvent(job.id, "requeued", "job requeued by operator");
      return { ok: true, status: "QUEUED" };
    }
    if (job.status === "FAILED") {
      ctx.jobs.setStatus(job.id, "QUEUED", {
        attempt: 0,
        progress: 0,
        progressNote: null,
        errorClass: null,
        errorMessage: null,
        nodeId: null, // force a fresh proxy selection
      });
      ctx.jobs.appendEvent(job.id, "retried", "job retried by operator (same account)");
      return { ok: true, status: "QUEUED" };
    }
    throw new ApiError(
      ApiCodes.invalidState,
      "only FAILED or NEEDS_ATTENTION jobs can be requeued",
      409,
    );
  });
}

async function saveMultipartToTemp(
  ctx: AppContext,
  stream: import("node:stream").Readable,
): Promise<string> {
  const { randomUUID } = await import("node:crypto");
  const { mkdirSync, createWriteStream } = await import("node:fs");
  const dir = path.join(dataPaths(ctx.config.dataDir).tempDir, "uploads");
  mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, `upl_${randomUUID()}`);
  const ws = createWriteStream(dest);
  await pipeline(stream, ws);
  return dest;
}

/** Consume and discard a stream (required to advance the multipart parser). */
async function drainStream(stream: import("node:stream").Readable): Promise<void> {
  const { Writable } = await import("node:stream");
  const sink = new Writable({
    write(_chunk, _enc, cb) {
      cb();
    },
  });
  await pipeline(stream, sink);
}

async function rm(file: string): Promise<void> {
  const { rm: rmFn } = await import("node:fs/promises");
  await rmFn(file, { force: true }).catch(() => {});
}

async function rmAll(files: string[]): Promise<void> {
  await Promise.all(files.map((f) => rm(f)));
}

async function sizeOf(file: string): Promise<number> {
  const { statSync } = await import("node:fs");
  return statSync(file).size;
}
