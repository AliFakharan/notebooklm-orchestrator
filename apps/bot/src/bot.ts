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
import { readFile, writeFile } from "node:fs/promises";
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
  KIND_COMMANDS,
  artifactSendPlan,
  botMessages,
  FlowManager,
  jobFailedMessage,
  mapAttachment,
  outputLabel,
  pickLargestPhoto,
  type AttachKind,
  type FlowAction,
  type SourceFile,
} from "./flow.js";
import { makeFetch } from "./http.js";
import { NloApi, NloApiError, type BotImportStatus, type BotJobSummary, type JobArtifact } from "./nlo-api.js";

const log = (m: string): void => console.log(`[nlo:bot] ${m}`);
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Max time to wait for the background cookie verification to finish. */
const COOKIE_IMPORT_WAIT_MS = 90_000;
const COOKIE_POLL_MS = 3_000;

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
    { command: "audio", description: "پادکست صوتی" },
    { command: "infographic", description: "اینفوگرافیک" },
    { command: "slides", description: "اسلاید (PDF)" },
    { command: "report", description: "گزارش" },
    { command: "quiz", description: "آزمون" },
    { command: "flashcards", description: "فلش‌کارت" },
    { command: "mindmap", description: "نقشه ذهنی" },
    { command: "datatable", description: "جدول داده" },
    { command: "cookie", description: "به‌روزرسانی کوکی گوگل" },
    { command: "finish", description: "پایان جلسه" },
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
        const job = await api.createJob({
          prompt: a.prompt,
          title: a.title,
          files: a.sources,
          output: a.output !== "answer" ? a.output : undefined,
          mode: a.mode,
          sessionId: a.sessionId ?? undefined,
          chatId: a.chatId ?? undefined,
        });
        flows.markSubmitted(chatId, job.id, job.sessionId);
        cleanChatTemps(chatId); // uploaded; temp copies no longer needed
        send(chatId, botMessages.submitted);
        log(
          `chat ${chatId}: job ${job.id} created (mode=${a.mode}${a.sessionId ? `, session=${a.sessionId}` : ""})`,
        );
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
      return;
    }
    if (a.type === "importCookies") {
      send(chatId, botMessages.cookieAccepted);
      try {
        const { sessions } = await api.listSessions();
        const view = sessions.find((s) => s.account?.enabled) ?? sessions[0];
        if (!view) {
          flows.cookieDone(chatId);
          send(chatId, botMessages.cookieNoAccount);
          log(`chat ${chatId}: importCookies — no account registered`);
          return;
        }
        const accountId = view.accountId;
        await api.importCookies(accountId, a.text);
        const status = await waitForCookieImport(api, accountId);
        flows.cookieDone(chatId);
        if (status.state === "AUTHENTICATED") {
          send(chatId, botMessages.cookieOk(status.email ?? view.account.displayEmail ?? "اکانت"));
          log(`chat ${chatId}: cookie import ok (${status.email ?? view.account.displayEmail ?? accountId})`);
        } else if (status.state === "AUTH_REQUIRED") {
          send(chatId, botMessages.cookieRejected(status.lastError ?? ""));
          log(`chat ${chatId}: cookie import rejected: ${status.lastError ?? "no reason"}`);
        } else if (status.state === "SESSION_INVALID") {
          send(chatId, botMessages.cookieMismatch);
          log(`chat ${chatId}: cookie import identity mismatch`);
        } else {
          send(chatId, botMessages.cookieTimeout);
          log(`chat ${chatId}: cookie import still ${status.state} after wait`);
        }
      } catch (e) {
        flows.cookieDone(chatId);
        if (e instanceof NloApiError) {
          if (e.unreachable) send(chatId, botMessages.apiDown);
          else if (e.status === 401 || e.status === 403) send(chatId, botMessages.authBad);
          else send(chatId, `⚠️ ${e.message}`);
          log(`chat ${chatId}: importCookies failed (HTTP ${e.status})`);
        } else {
          send(chatId, botMessages.apiDown);
          log(`chat ${chatId}: importCookies failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
    if (a.type === "finishSession") {
      try {
        const r = await api.finishSession(a.sessionId);
        send(chatId, botMessages.sessionFinished);
        log(`chat ${chatId}: session ${a.sessionId} finished → ${r.status}`);
      } catch (e) {
        if (e instanceof NloApiError) {
          if (e.unreachable) send(chatId, botMessages.apiDown);
          else if (e.status === 401 || e.status === 403) send(chatId, botMessages.authBad);
          else send(chatId, `⚠️ ${e.message}`);
          log(`chat ${chatId}: finishSession failed (HTTP ${e.status})`);
        } else {
          send(chatId, botMessages.apiDown);
          log(`chat ${chatId}: finishSession failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
    }
  };

  /**
   * Poll import-status until the state leaves AUTH_IN_PROGRESS (or the wait
   * budget is exhausted). Returns the last observed status.
   */
  const waitForCookieImport = async (
    api: NloApi,
    accountId: string,
  ): Promise<BotImportStatus> => {
    const deadline = Date.now() + COOKIE_IMPORT_WAIT_MS;
    let status: BotImportStatus = { state: "AUTH_IN_PROGRESS", email: null, lastError: null };
    while (Date.now() < deadline) {
      await sleep(COOKIE_POLL_MS);
      try {
        status = await api.importStatus(accountId);
      } catch (e) {
        log(`cookie import-status poll failed: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      if (status.state !== "AUTH_IN_PROGRESS") return status;
    }
    return status;
  };

  // --- job result delivery ---------------------------------------------------
  /**
   * Deliver a job's artifacts to the chat by kind. Returns true when at least
   * one artifact was delivered (so the caller can skip the text fallback).
   * Text-like kinds (report/quiz/flashcards) are read as markdown text and
   * sent chunked; media/structural kinds are sent as files via the right Bale
   * method. Temp downloads are tracked + cleaned per chat.
   */
   const deliverArtifacts = async (chatId: number, jobId: string, kind: string): Promise<boolean> => {
    let arts: JobArtifact[];
    try {
      arts = await api.listJobArtifacts(jobId);
    } catch (e) {
      log(`chat ${chatId}: listJobArtifacts failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
    let delivered = false;
    for (const art of arts) {
      const p = path.join(tmpDir, `${chatId}-art-${randomUUID()}`);
      trackTemp(chatId, p);
      try {
        await api.downloadJobArtifact(jobId, art.id, p);
        const ok = await sendArtifactByKind(chatId, kind, art, p);
        delivered = delivered || ok;
      } catch (e) {
        log(`chat ${chatId}: artifact ${art.id} download failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return delivered;
  };

  /** Pick the right Bale method for one artifact and send it. Returns success. */
  const sendArtifactByKind = async (
    chatId: number,
    kind: string,
    art: JobArtifact,
    filePath: string,
  ): Promise<boolean> => {
    const caption = `«${outputLabel[kind as keyof typeof outputLabel] ?? kind}»`;
    const plan = artifactSendPlan(kind, art.size);
    try {
      switch (plan) {
        case "audio":
          return await bale.sendAudio(chatId, filePath, art.filename, caption);
        case "photo":
          return await bale.sendPhoto(chatId, filePath, art.filename, caption);
        case "document":
          return await bale.sendDocument(chatId, filePath, art.filename, caption);
        case "text": {
          // Text-like: read the markdown and send it chunked as text.
          const text = (await readFile(filePath, "utf8")).trim();
          return await bale.sendMessage(chatId, text || caption);
        }
      }
    } catch (e) {
      log(`chat ${chatId}: sendArtifactByKind(${kind}) failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  };

  const handleJobResult = async (chatId: number, job: BotJobSummary): Promise<void> => {
    switch (job.status) {
      case "SUCCEEDED": {
        // Read the kind BEFORE jobDone leaves SUBMITTED (follow-ups keep
        // output; a failed create rolls back to "answer" via resetToIdle).
        const output = flows.flowFor(chatId).output ?? "answer";
        flows.jobDone(chatId, true);
        // Artifact jobs: deliver the generated file(s)/text, else fall back to
        // the answer markdown. The flow's `output` drives the kind selection.
        if (output !== "answer") {
          const delivered = await deliverArtifacts(chatId, job.id, output);
          if (delivered) {
            log(`chat ${chatId}: job ${job.id} artifact(s) delivered (${output})`);
            return;
          }
          log(`chat ${chatId}: job ${job.id} no artifact delivered; falling back to text`);
        }
        const answer = (job.answerMarkdown ?? "").trim() || "جاب خالی بود.";
        let text = answer;
        if (config.publicBaseUrl) text += `\n\n🔗 ${config.publicBaseUrl}/jobs/${job.id}`;
        await bale.sendMessage(chatId, text); // the important one: await chunked delivery
        log(`chat ${chatId}: job ${job.id} succeeded`);
        return;
      }
      case "FAILED": {
        flows.jobDone(chatId, false);
        send(chatId, jobFailedMessage(job.errorClass ?? "unknown"));
        log(`chat ${chatId}: job ${job.id} failed (${job.errorClass ?? "unknown"})`);
        return;
      }
      case "NEEDS_ATTENTION": {
        flows.jobDone(chatId, false);
        send(chatId, botMessages.needsAttention);
        log(`chat ${chatId}: job ${job.id} needs attention`);
        return;
      }
      case "CANCELLED": {
        flows.jobDone(chatId, false);
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

  /**
   * Map Bale attachments to job sources (cheap validation first), download the
   * valid ones to temp, and route them to the flow. Shared by the normal
   * attachment path and the command-as-caption path.
   */
  const routeAttachments = async (
    chatId: number,
    attachments: { kind: AttachKind; ref: BaleFileRef }[],
  ): Promise<void> => {
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
  };

  // --- redelivery guard --------------------------------------------------------
  // Bale can deliver the same message more than once (long-poll retries,
  // reconnects). Dispatching it twice would send a double reply (e.g. two
  // /start welcomes). Each (chat, message) pair is dispatched at most once
  // per process life; the bound keeps the set tiny (500 recent messages).
  const seenMessages = new Set<string>();
  const seenOrder: string[] = [];
  const alreadySeen = (chatId: number, messageId: number): boolean => {
    const key = `${chatId}:${messageId}`;
    if (seenMessages.has(key)) return true;
    seenMessages.add(key);
    seenOrder.push(key);
    if (seenOrder.length > 500) {
      const old = seenOrder.shift();
      if (old) seenMessages.delete(old);
    }
    return false;
  };

  const dispatch = async (u: BaleUpdate): Promise<void> => {
    const m = u.message;
    if (!m || !m.chat) return;
    const chatId = m.chat.id;
    if (m.message_id !== undefined && alreadySeen(chatId, m.message_id)) return;
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

      // Commands first. A kind command (/audio etc.) WITH an attachment treats
      // the attachment as the job source in the same dispatch (command-as-
      // caption): start the kind flow, then route the attachment to handleSource.
      if (text.startsWith("/")) {
        const cmd = (text.split(/\s+/)[0] ?? "").toLowerCase();
        const base = cmd.split("@")[0] ?? "";
        const kindCmd = base.replace(/^\//, "") as keyof typeof KIND_COMMANDS;
        const kind = KIND_COMMANDS[kindCmd];
        if (kind) {
          for (const a of flows.handleKindCommand(chatId, kind)) await exec(chatId, a);
          const atts = extractAttachments(m);
          if (atts.length > 0) await routeAttachments(chatId, atts);
          return;
        }
        if (base === "/start") {
          for (const a of flows.handleStart(chatId)) await exec(chatId, a);
        } else if (base === "/help") {
          for (const a of flows.handleHelp(chatId)) await exec(chatId, a);
        } else if (base === "/cookie") {
          for (const a of flows.handleCookieCommand(chatId)) await exec(chatId, a);
        } else if (base === "/finish") {
          for (const a of flows.handleFinish(chatId)) await exec(chatId, a);
        } else if (base === "/cancel") {
          for (const a of flows.handleCancel(chatId)) await exec(chatId, a);
        } else {
          send(chatId, botMessages.onlyFileOrText);
        }
        return;
      }

      const attachments = extractAttachments(m);
      if (attachments.length > 0) {
        // Cookie flow: a document file is the raw cookie payload (bypass the
        // source-extension mapping, which rejects .json).
        if (flows.peekState(chatId) === "WAIT_COOKIE") {
          const doc = attachments.find((x) => x.kind === "document");
          if (!doc) {
            send(chatId, botMessages.cookieFileOnly);
            return;
          }
          const p = path.join(tmpDir, `${chatId}-${randomUUID()}`);
          try {
            await bale.downloadFile(doc.ref.file_id, p);
            const text = await readFile(p, "utf8");
            for (const a of flows.handleText(chatId, text)) await exec(chatId, a);
          } catch (e) {
            send(chatId, botMessages.downloadFailed);
            log(`chat ${chatId}: cookie file download failed: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            rmSync(p, { force: true });
          }
          return;
        }
        await routeAttachments(chatId, attachments);
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
        flows.jobDone(chatId, false);
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
