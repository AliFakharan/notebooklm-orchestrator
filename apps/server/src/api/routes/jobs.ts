import { pipeline } from "node:stream/promises";
import path from "node:path";
import { z } from "zod";
import type { FastifyInstance } from "fastify";
import { ApiError, ApiCodes, resolveWithin, type JobInput } from "@nlo/shared";
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

export function registerJobRoutes(app: FastifyInstance, ctx: AppContext): void {
  // Create a job: multipart with fields prompt, preferredAccountId,
  // preferredNodeId and an optional file part "audio".
  app.post("/api/jobs", async (req, reply) => {
    const fields: Record<string, string> = {};
    // The multipart iterator only advances past a file part once its stream is
    // consumed, so we MUST drain each file stream INSIDE the loop (to a temp
    // file) or the request hangs forever.
    let audio: { filename: string; type: string; tempPath: string } | null = null;
    let tempAudioPath: string | null = null;

    try {
      for await (const part of req.parts()) {
        if (part.type === "file") {
          if (!audio) {
            tempAudioPath = await saveMultipartToTemp(ctx, part.file);
            audio = {
              filename: part.filename ?? "upload",
              type: part.mimetype ?? "application/octet-stream",
              tempPath: tempAudioPath,
            };
          } else {
            await drainStream(part.file); // extra file parts: discard
          }
        } else if (part.fieldname) {
          fields[part.fieldname] = String(part.value);
        }
      }
    } catch (err) {
      if (tempAudioPath) await rm(tempAudioPath);
      throw err;
    }

    const prompt = (fields.prompt ?? "").trim();
    if (!prompt) {
      if (tempAudioPath) await rm(tempAudioPath);
      throw new ApiError(ApiCodes.validation, "prompt is required", 400);
    }

    const preferredAccountId = fields.preferredAccountId || null;
    const preferredNodeId = fields.preferredNodeId || null;

    // Reject an unknown account ID up front (clearer than a runner failure
    // later); the runner re-checks eligibility + a live verified session.
    if (preferredAccountId && !ctx.accounts.get(preferredAccountId)) {
      if (tempAudioPath) await rm(tempAudioPath);
      throw new ApiError(ApiCodes.notFound, "preferred account not found", 404);
    }

    // Validate + hash the audio if present.
    let audioMeta: JobInput["audio"] = {
      originalName: "",
      mediaType: "",
      size: 0,
      sha256: "",
      providerConfirmed: false,
    };

    if (audio && tempAudioPath) {
      const ext = path.extname(audio.filename).toLowerCase().replace(".", "");
      try {
        if (!ctx.config.allowedAudioExtensions.includes(ext)) {
          throw new ApiError(ApiCodes.validation, `unsupported audio extension: .${ext}`, 400);
        }
        const size = await sizeOf(tempAudioPath);
        if (size === 0) {
          throw new ApiError(ApiCodes.validation, "audio file is empty", 400);
        }
        if (size > ctx.config.maxUploadBytes) {
          throw new ApiError(ApiCodes.validation, "audio file exceeds size limit", 413);
        }
        const { sha256OfFile } = await import("../../domain/archive.js");
        audioMeta = {
          originalName: audio.filename,
          mediaType: audio.type || `audio/${ext}`,
          size,
          sha256: sha256OfFile(tempAudioPath),
          // Only .wav is confirmed by the real provider; others are unverified.
          providerConfirmed: ext === "wav",
        };
      } catch (err) {
        await rm(tempAudioPath);
        throw err;
      }
    }

    const job = ctx.jobs.create({
      input: {
        prompt,
        audio: audioMeta,
        preferredAccountId,
        preferredNodeId,
      },
      configSnapshot: {
        provider: ctx.provider.name,
        proxyRuntime: ctx.config.proxyRuntime,
        host: ctx.config.host,
      },
    });

    // Initialize the archive and store the audio under a sanitized name.
    try {
      const archive = new JobArchive(dataPaths(ctx.config.dataDir).jobsDir, job.id);
      archive.init({
        prompt,
        originalAudioName: audioMeta.size > 0 ? audioMeta.originalName : null,
        audioMediaType: audioMeta.size > 0 ? audioMeta.mediaType : null,
        configSnapshot: job.configSnapshot,
        createdAt: job.createdAt,
      });
      if (audio && tempAudioPath) {
        await archive.storeAudio(tempAudioPath, audioMeta.originalName);
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
      // The temp upload is copied into the archive; drop the temp copy.
      if (tempAudioPath) await rm(tempAudioPath);
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

  // Re-queue a NEEDS_ATTENTION job (human reconciliation).
  app.post<{ Params: { id: string } }>("/api/jobs/:id/requeue", async (req) => {
    const job = ctx.jobs.get(req.params.id);
    if (!job) throw new ApiError(ApiCodes.notFound, "job not found", 404);
    if (job.status !== "NEEDS_ATTENTION") {
      throw new ApiError(ApiCodes.invalidState, "only NEEDS_ATTENTION jobs can be requeued", 409);
    }
    ctx.jobs.setStatus(job.id, "QUEUED");
    ctx.jobs.appendEvent(job.id, "requeued", "job requeued by operator");
    return { ok: true, status: "QUEUED" };
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

async function sizeOf(file: string): Promise<number> {
  const { statSync } = await import("node:fs");
  return statSync(file).size;
}
