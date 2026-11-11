/**
 * NLO public Bale bot — entrypoint.
 *
 * Long-polls Bale (private chats only), walks the per-chat flow
 * (file/text → title → prompt), creates jobs via the orchestrator job API
 * (Bearer API key), polls each job to a terminal state and sends the answer
 * back in chunks. No DB, no in-process coupling with the server.
 *
 * Secrets (token, API key) are never logged; user-facing errors are generic
 * Persian templates (no stacks, no internals).
 */

import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  BaleApiError,
  BaleClient,
  type BaleFileRef,
  type BaleMessage,
  type BaleUpdate,
} from "./bale.js";
import { loadBotConfig, loadBotDotEnv } from "./config.js";
import {
  botMessages,
  FlowManager,
  jobFailedMessage,
  mapAttachment,
  pickLargestPhoto,
  type AttachKind,
  type FlowAction,
  type SourceFile,
} from "./flow.js";
import { makeFetch } from "./http.js";
import { NloApi, NloApiError, type BotJobSummary } from "./nlo-api.js";

const log = (m: string): void => console.log(`[nlo:bot] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  loadBotDotEnv();
  const config = loadBotConfig();
  const fetchImpl = await makeFetch();

  const stopSignal = new AbortController();
  const bale = new BaleClient({ token: config.token, apiBase: config.baleApiBase, fetchImpl, log, abortSignal: stopSignal.signal });
  const api = new NloApi({ apiBase: config.apiBase, apiKey: config.apiKey, fetchImpl, log });
  const flows = new FlowManager({
    ttlMs: config.flowTtlMs,
    jobTimeoutMs: config.jobTimeoutMs,
    maxJobsPerChatPerDay: config.maxJobsPerChatPerDay,
    maxTitleChars: config.maxTitleChars,
    maxPromptChars: config.maxPromptChars,
  });

  const me = await bale.getMe();
  if (!me) {
    console.error("[nlo:bot] Bale getMe failed — check NLO_BOT_TOKEN / network");
    process.exit(1);
  }
  log(`bot ready as ${me.username ? `@${me.username}` : String(me.id)}; api=${config.apiBase}`);
  await bale.setMyCommands([
    { command: "start", description: "شروع" },
    { command: "help", description: "راهنما" },
    { command: "cancel", description: "لغو جاب جاری" },
  ]);

  // --- temp-file registry (per chat; cleaned on reset/done/TTL/exit) -------
  const tmpDir = path.join(os.tmpdir(), "nlo-bot");
  mkdirSync(tmpDir, { recursive: true });
  const tempFiles = new Map<number, Set<string>>();
  const trackTemp = (chatId: number, p: string): void => {
    let s = tempFiles.get(chatId);
    if (!s) {
      s = new Set();
      tempFiles.set(chatId, s);
    }
    s.add(p);
  };
  const cleanChatTemps = (chatId: number): void => {
    for (const p of tempFiles.get(chatId) ?? []) rmSync(p, { force: true });
    tempFiles.delete(chatId);
  };
  const cleanAllTemps = (): void => {
    for (const chatId of [...tempFiles.keys()]) cleanChatTemps(chatId);
  };
  // Drop stale files from a previous run (older than the flow TTL).
  for (const name of readdirSync(tmpDir)) {
    const p = path.join(tmpDir, name);
    try {
      if (Date.now() - statSync(p).mtimeMs > config.flowTtlMs) rmSync(p, { force: true });
    } catch {
      /* ignore */
    }
  }

  // --- outbound sends (tracked for graceful shutdown: no partial sends) ----
  const inFlight = new Set<Promise<void>>();
  const send = (chatId: number, text: string): void => {
    const p = bale
      .sendMessage(chatId, text)
      .then(() => undefined)
      .catch(() => undefined)
      .finally(() => {
        inFlight.delete(p);
      });
    inFlight.add(p);
  };

  // --- action execution -----------------------------------------------------
  const exec = async (chatId: number, a: FlowAction): Promise<void> => {
    if (a.type === "send") {
      send(chatId, a.text);
      return;
    }
    if (a.type === "createJob") {
      try {
        const job = await api.createJob({ prompt: a.prompt, title: a.title, files: a.sources });
        flows.markSubmitted(chatId, job.id);
        cleanChatTemps(chatId); // uploaded; temp copies no longer needed
        send(chatId, botMessages.submitted);
        log(`chat ${chatId}: job ${job.id} created`);
      } catch (e) {
        flows.onJobSubmitFailed(chatId);
        cleanChatTemps(chatId);
        if (e instanceof NloApiError) {
          if (e.unreachable) send(chatId, botMessages.apiDown);
          else if (e.status === 401 || e.status === 403) send(chatId, botMessages.authBad);
          else send(chatId, `⚠️ ${e.message}`);
          log(`chat ${chatId}: createJob failed (HTTP ${e.status})`);
        } else {
          send(chatId, botMessages.apiDown);
          log(`chat ${chatId}: createJob failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      return;
    }
    if (a.type === "cancelJob") {
      try {
        const r = await api.cancelJob(a.jobId);
        flows.jobCancelled(chatId);
        send(chatId, r.cancelled ? botMessages.cancelled : botMessages.cancelIdle);
        log(`chat ${chatId}: job ${a.jobId} cancel → ${r.status}`);
      } catch (e) {
        if (e instanceof NloApiError && e.status === 404) {
          flows.jobCancelled(chatId);
          send(chatId, botMessages.jobNotFound);
          log(`chat ${chatId}: cancel of unknown job ${a.jobId}`);
        } else {
          send(chatId, botMessages.cancelFailed);
          log(`chat ${chatId}: cancelJob failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  };

  // --- job result delivery ---------------------------------------------------
  const handleJobResult = async (chatId: number, job: BotJobSummary): Promise<void> => {
    switch (job.status) {
      case "SUCCEEDED": {
        flows.jobDone(chatId);
        const answer = (job.answerMarkdown ?? "").trim() || "جاب خالی بود.";
        let text = answer;
        if (config.publicBaseUrl) text += `\n\n🔗 ${config.publicBaseUrl}/jobs/${job.id}`;
        await bale.sendMessage(chatId, text); // the important one: await chunked delivery
        log(`chat ${chatId}: job ${job.id} succeeded`);
        return;
      }
      case "FAILED": {
        flows.jobDone(chatId);
        send(chatId, jobFailedMessage(job.errorClass ?? "unknown"));
        log(`chat ${chatId}: job ${job.id} failed (${job.errorClass ?? "unknown"})`);
        return;
      }
      case "NEEDS_ATTENTION": {
        flows.jobDone(chatId);
        send(chatId, botMessages.needsAttention);
        log(`chat ${chatId}: job ${job.id} needs attention`);
        return;
      }
      case "CANCELLED": {
        flows.jobDone(chatId);
        send(chatId, botMessages.cancelled);
        log(`chat ${chatId}: job ${job.id} cancelled externally`);
        return;
      }
      default:
        return; // still running
    }
  };

  // --- update dispatch ---------------------------------------------------------
  const extractAttachments = (m: BaleMessage): { kind: AttachKind; ref: BaleFileRef }[] => {
    const out: { kind: AttachKind; ref: BaleFileRef }[] = [];
    if (m.document) out.push({ kind: "document", ref: m.document });
    if (m.photo && m.photo.length > 0) out.push({ kind: "photo", ref: pickLargestPhoto(m.photo) });
    if (m.audio) out.push({ kind: "audio", ref: m.audio });
    if (m.voice) out.push({ kind: "voice", ref: m.voice });
    if (m.video) out.push({ kind: "video", ref: m.video });
    return out;
  };

  const dispatch = async (u: BaleUpdate): Promise<void> => {
    const m = u.message;
    if (!m || !m.chat) return;
    const chatId = m.chat.id;
    try {
      if (m.chat.type !== "private") {
        // Groups: reply once, then stay quiet (v1 is private-only).
        const groupChats = dispatch.groupChats;
        if (!groupChats.has(chatId)) {
          groupChats.add(chatId);
          send(chatId, botMessages.privateOnly);
        }
        return;
      }
      const text = (m.text ?? m.caption ?? "").trim();

      // Commands first.
      if (text.startsWith("/")) {
        const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase();
        const base = cmd.split("@")[0] ?? "";
        if (base === "/start") {
          for (const a of flows.handleStart(chatId)) await exec(chatId, a);
        } else if (base === "/help") {
          for (const a of flows.handleHelp(chatId)) await exec(chatId, a);
        } else if (base === "/cancel") {
          for (const a of flows.handleCancel(chatId)) await exec(chatId, a);
        } else {
          send(chatId, botMessages.onlyFileOrText);
        }
        return;
      }

      const attachments = extractAttachments(m);
      if (attachments.length > 0) {
        // Map first (cheap failures before any download).
        const mapped: { ref: BaleFileRef; filename: string; contentType: string }[] = [];
        const errors = new Set<string>();
        for (const att of attachments) {
          const r = mapAttachment(att.kind, att.ref, config.maxUploadBytes);
          if ("error" in r) {
            if (!errors.has(r.error)) errors.add(r.error);
            continue;
          }
          mapped.push({ ref: att.ref, filename: r.filename, contentType: r.contentType });
        }
        for (const err of errors) {
          send(chatId, err === "tooLarge" ? botMessages.fileTooLarge : botMessages.unsupportedType);
        }
        if (mapped.length === 0) return;
        // Download the valid ones.
        const files: SourceFile[] = [];
        let anyFailed = false;
        for (const { ref, filename, contentType } of mapped) {
          const p = path.join(tmpDir, `${chatId}-${randomUUID()}`);
          try {
            await bale.downloadFile(ref.file_id, p);
            trackTemp(chatId, p);
            files.push({ path: p, filename, contentType });
          } catch (e) {
            anyFailed = true;
            rmSync(p, { force: true });
            log(`chat ${chatId}: download failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        if (files.length === 0) {
          send(chatId, botMessages.downloadFailed);
          return;
        }
        for (const a of flows.handleSource(chatId, files)) await exec(chatId, a);
        if (anyFailed && files.length > 0) send(chatId, botMessages.downloadFailed);
        return;
      }

      if (text) {
        if (flows.peekState(chatId) === "IDLE" || flows.peekState(chatId) === "WAIT_SOURCE") {
          // Plain text IS the source: wrap as a temp .txt.
          const p = path.join(tmpDir, `${chatId}-${randomUUID()}`);
          await writeFile(p, text, "utf8");
          trackTemp(chatId, p);
          for (const a of flows.handleSource(chatId, [{ path: p, filename: `source-${Date.now()}.txt` }])) {
            await exec(chatId, a);
          }
        } else {
          for (const a of flows.handleText(chatId, text)) await exec(chatId, a);
        }
        return;
      }

      // Neither file nor text (sticker, location, …).
      for (const a of flows.handleUnsupported(chatId)) await exec(chatId, a);
    } catch (e) {
      // One bad update must never kill the loop.
      log(`dispatch error (chat ${chatId}): ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  dispatch.groupChats = new Set<number>();

  // --- update loop -------------------------------------------------------------
  let offset = 0;
  // Drain the backlog on boot (up to 2000 updates kept 24 h by Bale): advance
  // the offset WITHOUT dispatching, so old messages never re-trigger jobs.
  const drainBacklog = async (): Promise<void> => {
    let drained = 0;
    for (let guard = 0; guard < 20; guard++) {
      const batch = await bale.getUpdates(offset, 0);
      if (batch.length === 0) break;
      offset = batch.reduce((max, u) => Math.max(max, u.update_id), offset);
      drained += batch.length;
      if (batch.length < 100) break;
    }
    if (drained > 0) log(`discarded ${drained} backlog update(s) from before boot`);
  };
  try {
    await drainBacklog();
  } catch (e) {
    log(`backlog drain failed (will retry via the main loop): ${e instanceof Error ? e.message : String(e)}`);
  }

  const loop = async (): Promise<void> => {
    while (!stopSignal.signal.aborted) {
      let updates: BaleUpdate[];
      try {
        updates = await bale.getUpdates(offset, 30);
      } catch (e) {
        if (stopSignal.signal.aborted) break;
        if (e instanceof BaleApiError && e.status === 429 && e.retryAfterSec !== null) {
          log(`bale rate limited; sleeping ${e.retryAfterSec}s`);
          await sleep(e.retryAfterSec * 1000);
          continue;
        }
        log(`getUpdates failed: ${e instanceof Error ? e.message : String(e)}; retrying in 5s`);
        await sleep(5000);
        continue;
      }
      if (stopSignal.signal.aborted) break;
      if (updates.length > 0) {
        offset = updates.reduce((max, u) => Math.max(max, u.update_id), 0) + 1;
        for (const u of updates) {
          if (stopSignal.signal.aborted) break;
          await dispatch(u);
        }
      }
    }
  };

  // --- job poller ----------------------------------------------------------------
  const pollJobs = async (): Promise<void> => {
    if (stopSignal.signal.aborted) return;
    for (const f of flows.submittedFlows()) {
      if (stopSignal.signal.aborted) break;
      const chatId = f.chatId;
      const jobId = f.jobId;
      if (!jobId) continue;
      if (f.jobDeadline !== null && Date.now() > f.jobDeadline) {
        flows.jobDone(chatId);
        send(chatId, botMessages.jobTimeout);
        log(`chat ${chatId}: job ${jobId} timed out`);
        continue;
      }
      try {
        const job = await api.getJob(jobId);
        await handleJobResult(chatId, job);
      } catch (e) {
        if (e instanceof NloApiError && e.status === 404) {
          flows.jobDone(chatId);
          send(chatId, botMessages.jobNotFound);
          log(`chat ${chatId}: polled job ${jobId} not found`);
        } else {
          log(`poll job ${jobId} failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  };
  const pollTimer = setInterval(() => void pollJobs(), config.pollIntervalMs);
  pollTimer.unref();

  // Flow TTL hygiene (reset stale flows + clean their temp files).
  const sweepTimer = setInterval(() => {
    for (const f of flows.sweep()) cleanChatTemps(f.chatId);
  }, 60_000);
  sweepTimer.unref();

  // --- graceful shutdown ------------------------------------------------------------
  let stopped = false;
  const stop = (sig: string): void => {
    if (stopped) return;
    stopped = true;
    log(`${sig} received; shutting down`);
    stopSignal.abort();
    clearInterval(pollTimer);
    clearInterval(sweepTimer);
    const deadline = Date.now() + 3000;
    void (async () => {
      while (inFlight.size > 0 && Date.now() < deadline) await sleep(100);
      cleanAllTemps();
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => stop("SIGTERM"));
  process.on("SIGINT", () => stop("SIGINT"));
  process.on("unhandledRejection", (e) =>
    log(`unhandled rejection: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`),
  );

  await loop();
  // Loop exited (stopped): make sure we finish cleanly.
  clearInterval(pollTimer);
  clearInterval(sweepTimer);
  cleanAllTemps();
  process.exit(0);
}

main().catch((e) => {
  console.error("[nlo:bot] fatal:", e);
  process.exit(1);
});
