/**
 * Per-chat flow state machine + public-bot limits + Persian templates.
 *
 * States:
 *  IDLE → (file/text as source) → WAIT_TITLE → WAIT_PROMPT → SUBMITTED → IDLE
 *  /start puts a chat into WAIT_SOURCE (welcome); IDLE and WAIT_SOURCE both
 *  accept a file/text as the job's source.
 *
 * The flow never touches the network or the filesystem: it returns FlowAction
 * values that the entrypoint (bot.ts) executes, and carries SourceFile
 * references (temp paths) that bot.ts created and must clean up.
 */

import {
  ALLOWED_SOURCE_EXTENSIONS,
  MAX_SOURCES_PER_JOB,
  safeName,
  type FailureClass,
} from "@nlo/shared";
import type { BalePhotoSize } from "./bale.js";

export type FlowState = "IDLE" | "WAIT_SOURCE" | "WAIT_TITLE" | "WAIT_PROMPT" | "SUBMITTED";

export interface SourceFile {
  /** Temp file on disk (bot-owned; cleaned up by bot.ts). */
  path: string;
  /** Upload file name (sanitized). */
  filename: string;
  /** MIME type for the upload part (optional; the server re-derives when absent). */
  contentType?: string;
}

export type FlowAction =
  | { type: "send"; text: string }
  | { type: "createJob"; title: string | null; prompt: string; sources: SourceFile[] }
  | { type: "cancelJob"; jobId: string };

export interface Flow {
  chatId: number;
  state: FlowState;
  sources: SourceFile[];
  title: string | null;
  prompt: string | null;
  jobId: string | null;
  jobSubmittedAt: number | null;
  jobDeadline: number | null;
  /** Submit timestamps (for the per-chat 24 h limit). */
  jobStartTimestamps: number[];
  updatedAt: number;
}

export interface FlowManagerOpts {
  /** Injectable clock (tests). */
  now?: () => number;
  ttlMs?: number;
  jobTimeoutMs?: number;
  maxJobsPerChatPerDay?: number;
  maxTitleChars?: number;
  maxPromptChars?: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Persian user-facing templates (no internals, no secrets). */
export const botMessages = {
  welcome:
    "سلام! 👋\nمن دستیار NLO هستم.\nفایل یا متنت را بفرست، بعد عنوان و سوال/دستورت را بنویس تا برایت کار کنم.\n\n📖 /help راهنما\n✋ /cancel لغو",
  help:
    "راهنما:\n۱) فایل یا متن بفرست (PDF, DOCX, PPTX, CSV, TXT, MD, EPUB, عکس, صدا, ویدیو یا متن ساده)\n۲) یک عنوان بفرست\n۳) سوال یا دستور خودت را بنویس\n\nجاب ساخته می‌شود و به‌محض اتمام، جواب را همین‌جا می‌فرستم.\n\n✋ /cancel — لغو جاب جاری",
  hintSource: "📎 حالا فایل یا 📝 متن خودت را بفرست.",
  onlyFileOrText: "فقط فایل یا متن را می‌فهمم. /help برای راهنما.",
  privateOnly: "فقط در گفتگوی خصوصی کار می‌کنم.",
  askTitle: "حالا یک عنوان کوتاه برای این جاب بفرست (حداکثر ۲۰۰ کاراکتر). ✋ /cancel",
  askPrompt: "حالا سوال یا دستورت را بنویس (حداکثر ۲۰۰۰ کاراکتر). ✋ /cancel",
  titleTooLong: "عنوان خیلی طولانی است؛ کوتاه‌ترش کن (حداکثر ۲۰۰ کاراکتر).",
  promptTooLong: "سوال خیلی طولانی است؛ کوتاه‌ترش کن (حداکثر ۲۰۰۰ کاراکتر).",
  titleTextOnly: "لطفاً عنوان را به‌صورت متن بفرست.",
  promptTextOnly: "لطفاً سوال را به‌صورت متن بفرست.",
  submitted: "✅ جاب ساخته شد؛ به‌محض اتمام خبر می‌دهم. (لغو: /cancel)",
  busy: "جاب قبلی هنوز در حال اجراست؛ کمی صبر کن. (لغو: /cancel)",
  cancelIdle: "فعلاً جابی در جریان نیست.",
  cancelledFlow: "انصراف شد. برای شروع دوباره /start بزن.",
  cancelled: "جاب لغو شد.",
  cancelFailed: "لغو نشد؛ دوباره /cancel بزن.",
  jobNotFound: "جاب پیدا نشد.",
  apiDown: "⚠️ به سرور نمی‌رسم (API در دسترس نیست). بعداً دوباره امتحان کن.",
  authBad: "⚠️ کلید دسترسی نامعتبر است؛ با مدیر تماس بگیر.",
  limit: "به سقف استفاده (۵ جاب در ۲۴ ساعت) رسیدی؛ کمی بعد دوباره امتحان کن.",
  fileTooLarge: "⚠️ حجم این فایل بیشتر از حد مجاز (۱۰۰ مگابایت) است.",
  unsupportedType:
    "⚠️ این نوع فایل پشتیبانی نمی‌شود. (فرمت‌های مجاز: PDF, DOCX, PPTX, CSV, TXT, MD, EPUB, عکس, صدا, ویدیو)",
  downloadFailed: "⚠️ دریافت فایل از بله ناموفق بود؛ دوباره بفرست.",
  tooManyFiles: `حداکثر ${MAX_SOURCES_PER_JOB} فایل در هر جاب.`,
  needsAttention: "⚠️ جاب به بررسی نیاز دارد؛ در پنل مدیریت بررسی کن.",
  jobTimeout: "جاب بیش از حد مجاز طول کشید؛ در پنل مدیریت بررسی کن.",
} as const;

const FAILED_MESSAGES: Record<FailureClass, string> = {
  auth: "⚠️ مشکل در ورود به اکانت گوگل بود؛ جاب انجام نشد.",
  rate_limit: "⚠️ سرویس در این لحظه مشغول است؛ جاب انجام نشد. بعداً دوباره امتحان کن.",
  invalid_input: "⚠️ ورودی جاب (فایل/متن) معتبر نبود.",
  connectivity: "⚠️ مشکل در اتصال بود؛ جاب انجام نشد.",
  provider: "⚠️ خطا در حین پردازش بود؛ جاب انجام نشد.",
  proxy: "⚠️ مشکل در مسیر اتصال بود؛ جاب انجام نشد.",
  ambiguous: "⚠️ جاب با خطا انجام نشد.",
  unknown: "⚠️ جاب با خطا انجام نشد.",
};

/** Short Persian message from the job's failure class (no secrets/stacks). */
export function jobFailedMessage(errorClass: FailureClass | null | undefined): string {
  return (errorClass && FAILED_MESSAGES[errorClass]) || FAILED_MESSAGES.unknown;
}

export class FlowManager {
  private readonly flows = new Map<number, Flow>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly jobTimeoutMs: number;
  private readonly maxJobsPerDay: number;
  private readonly maxTitleChars: number;
  private readonly maxPromptChars: number;

  constructor(opts: FlowManagerOpts = {}) {
    this.now = opts.now ?? Date.now;
    this.ttlMs = opts.ttlMs ?? 60 * 60_000;
    this.jobTimeoutMs = opts.jobTimeoutMs ?? 40 * 60_000;
    this.maxJobsPerDay = opts.maxJobsPerChatPerDay ?? 5;
    this.maxTitleChars = opts.maxTitleChars ?? 200;
    this.maxPromptChars = opts.maxPromptChars ?? 2000;
  }

  /** Get (creating if needed) the flow for a chat, applying the idle TTL. */
  flowFor(chatId: number): Flow {
    let f = this.flows.get(chatId);
    if (!f) {
      f = {
        chatId,
        state: "IDLE",
        sources: [],
        title: null,
        prompt: null,
        jobId: null,
        jobSubmittedAt: null,
        jobDeadline: null,
        jobStartTimestamps: [],
        updatedAt: this.now(),
      };
      this.flows.set(chatId, f);
    }
    this.enforceTtl(f);
    return f;
  }

  peekState(chatId: number): FlowState {
    return this.flowFor(chatId).state;
  }

  private enforceTtl(f: Flow): void {
    if (f.state !== "IDLE" && this.now() - f.updatedAt > this.ttlMs) {
      this.resetToIdle(f);
    }
  }

  private resetToIdle(f: Flow): void {
    f.state = "IDLE";
    f.sources = [];
    f.title = null;
    f.prompt = null;
    f.jobId = null;
    f.jobSubmittedAt = null;
    f.jobDeadline = null;
    f.updatedAt = this.now();
  }

  /**
   * Periodic hygiene: reset expired non-IDLE flows (returned so the caller
   * can clean their temp files) and forget long-idle IDLE flows.
   */
  sweep(): Flow[] {
    const affected: Flow[] = [];
    for (const [chatId, f] of this.flows) {
      if (f.state !== "IDLE" && this.now() - f.updatedAt > this.ttlMs) {
        this.resetToIdle(f);
        affected.push(f);
      } else if (f.state === "IDLE" && this.now() - f.updatedAt > this.ttlMs) {
        this.flows.delete(chatId);
      }
    }
    return affected;
  }

  // --- commands -----------------------------------------------------------

  /** /start — fresh flow (unless a job is in flight). */
  handleStart(chatId: number): FlowAction[] {
    const f = this.flowFor(chatId);
    if (f.state === "SUBMITTED" && f.jobId) return [{ type: "send", text: botMessages.busy }];
    this.resetToIdle(f);
    f.state = "WAIT_SOURCE";
    return [{ type: "send", text: botMessages.welcome }];
  }

  /** /help — reference text; does not disturb an in-progress flow. */
  handleHelp(chatId: number): FlowAction[] {
    this.flowFor(chatId);
    return [{ type: "send", text: botMessages.help }];
  }

  /**
   * /cancel — by state:
   *  IDLE/WAIT_SOURCE → nothing to cancel
   *  WAIT_TITLE/WAIT_PROMPT → drop the flow
   *  SUBMITTED → cancelJob action (bot.ts posts /cancel to the API)
   */
  handleCancel(chatId: number): FlowAction[] {
    const f = this.flowFor(chatId);
    switch (f.state) {
      case "IDLE":
      case "WAIT_SOURCE":
        return [{ type: "send", text: botMessages.cancelIdle }];
      case "WAIT_TITLE":
      case "WAIT_PROMPT":
        this.resetToIdle(f);
        return [{ type: "send", text: botMessages.cancelledFlow }];
      case "SUBMITTED": {
        if (!f.jobId) {
          this.resetToIdle(f);
          return [{ type: "send", text: botMessages.cancelIdle }];
        }
        return [{ type: "cancelJob", jobId: f.jobId }];
      }
    }
  }

  /** Leave SUBMITTED after the job was cancelled (or is already terminal). */
  jobCancelled(chatId: number): void {
    const f = this.flowFor(chatId);
    if (f.state !== "SUBMITTED") return;
    this.resetToIdle(f);
  }

  /** Leave SUBMITTED after a terminal result (or timeout). */
  jobDone(chatId: number): void {
    const f = this.flowFor(chatId);
    if (f.state !== "SUBMITTED") return;
    this.resetToIdle(f);
  }

  // --- sources ------------------------------------------------------------

  /**
   * A file/text arrived as the job's source (already wrapped as SourceFile by
   * the caller — plain text becomes a temp .txt). IDLE/WAIT_SOURCE accept;
   * other states answer with a hint.
   */
  handleSource(chatId: number, files: SourceFile[]): FlowAction[] {
    if (files.length === 0) return [];
    const f = this.flowFor(chatId);
    switch (f.state) {
      case "IDLE":
      case "WAIT_SOURCE": {
        f.state = "WAIT_SOURCE";
        f.updatedAt = this.now();
        const room = MAX_SOURCES_PER_JOB - f.sources.length;
        const accepted = files.slice(0, Math.max(0, room));
        f.sources.push(...accepted);
        const actions: FlowAction[] = [];
        if (files.length > accepted.length) {
          actions.push({ type: "send", text: botMessages.tooManyFiles });
        }
        f.state = "WAIT_TITLE";
        actions.push({ type: "send", text: botMessages.askTitle });
        return actions;
      }
      case "WAIT_TITLE":
        return [{ type: "send", text: botMessages.titleTextOnly }];
      case "WAIT_PROMPT":
        return [{ type: "send", text: botMessages.promptTextOnly }];
      case "SUBMITTED":
        return [{ type: "send", text: botMessages.busy }];
    }
  }

  /**
   * A plain-text message that is NOT a source (WAIT_TITLE / WAIT_PROMPT /
   * SUBMITTED). IDLE/WAIT_SOURCE should not receive text here (the caller
   * routes text-as-source first) — the hint is a defensive fallback.
   */
  handleText(chatId: number, text: string): FlowAction[] {
    const f = this.flowFor(chatId);
    const trimmed = text.trim();
    switch (f.state) {
      case "IDLE":
      case "WAIT_SOURCE":
        return [{ type: "send", text: botMessages.hintSource }];
      case "WAIT_TITLE": {
        if (!trimmed) return [{ type: "send", text: botMessages.askTitle }];
        if (trimmed.length > this.maxTitleChars) {
          return [{ type: "send", text: botMessages.titleTooLong }];
        }
        f.title = trimmed;
        f.state = "WAIT_PROMPT";
        f.updatedAt = this.now();
        return [{ type: "send", text: botMessages.askPrompt }];
      }
      case "WAIT_PROMPT": {
        if (!trimmed) return [{ type: "send", text: botMessages.askPrompt }];
        if (trimmed.length > this.maxPromptChars) {
          return [{ type: "send", text: botMessages.promptTooLong }];
        }
        f.prompt = trimmed;
        return this.submitJob(f);
      }
      case "SUBMITTED":
        return [{ type: "send", text: botMessages.busy }];
    }
  }

  /** A message of an unsupported type (sticker/location/…). */
  handleUnsupported(chatId: number): FlowAction[] {
    const f = this.flowFor(chatId);
    f.updatedAt = this.now();
    if (f.state === "SUBMITTED") return [{ type: "send", text: botMessages.busy }];
    return [{ type: "send", text: botMessages.onlyFileOrText }];
  }

  // --- job lifecycle hooks (called by bot.ts after API calls) -------------

  /** Record the 201 job id for a SUBMITTED flow. */
  markSubmitted(chatId: number, jobId: string): void {
    const f = this.flowFor(chatId);
    if (f.state !== "SUBMITTED" || f.jobId) return;
    f.jobId = jobId;
  }

  /** createJob failed (4xx / network): roll back quota and go IDLE. */
  onJobSubmitFailed(chatId: number): void {
    const f = this.flowFor(chatId);
    f.jobStartTimestamps.pop();
    this.resetToIdle(f);
  }

  /** SUBMITTED flows with a known job id (for the poller). */
  submittedFlows(): Flow[] {
    return [...this.flows.values()].filter((f) => f.state === "SUBMITTED" && f.jobId !== null);
  }

  private submitJob(f: Flow): FlowAction[] {
    const now = this.now();
    f.updatedAt = now;
    f.jobStartTimestamps = f.jobStartTimestamps.filter((t) => now - t < DAY_MS);
    if (f.jobStartTimestamps.length >= this.maxJobsPerDay) {
      // Quota consumed for the window; the flow is unusable until it slides.
      this.resetToIdle(f);
      return [{ type: "send", text: botMessages.limit }];
    }
    f.jobStartTimestamps.push(now);
    f.state = "SUBMITTED";
    f.jobSubmittedAt = now;
    f.jobDeadline = now + this.jobTimeoutMs;
    f.jobId = null; // set via markSubmitted after the API 201
    return [{ type: "createJob", title: f.title, prompt: f.prompt ?? "", sources: f.sources }];
  }
}

// --- Bale attachment → source mapping (pure; unit-tested) ------------------

export type AttachKind = "document" | "photo" | "audio" | "voice" | "video";

export interface MappedSource {
  filename: string;
  contentType: string;
}

export type MappingError = { error: "tooLarge" | "unsupportedType" };

const EXT_MIME: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  csv: "text/csv",
  txt: "text/plain",
  md: "text/markdown",
  epub: "application/epub+zip",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/opus",
  wav: "audio/wav",
  mp4: "video/mp4",
  avi: "video/x-msvideo",
  mpeg: "video/mpeg",
};

/** Fallback extension when a nameless audio/video only carries a mime type. */
const MIME_EXT: Record<string, string> = {
  "audio/mpeg": "mp3",
  "audio/ogg": "ogg",
  "audio/mp4": "m4a",
  "audio/aac": "aac",
  "audio/opus": "opus",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "video/mp4": "mp4",
  "video/x-msvideo": "avi",
  "video/mpeg": "mpeg",
  "video/3gpp": "3gp",
};

function extOf(name: string): string {
  const i = name.lastIndexOf(".");
  if (i <= 0 || i === name.length - 1) return "";
  return name.slice(i + 1).toLowerCase();
}

/**
 * Map a Bale attachment to an upload file name/content type.
 *  - document → keep the original (sanitized) name; extension must be allowed
 *  - photo → photo-<ts>.jpg (largest PhotoSize, picked by the caller)
 *  - voice → voice-<ts>.ogg
 *  - audio/video → keep the extension when it is allowed, else reject
 * Size is pre-checked against `maxBytes` (UX only; the server re-validates).
 */
export function mapAttachment(
  kind: AttachKind,
  ref: { file_id?: string; file_name?: string; mime_type?: string; file_size?: number },
  maxBytes: number,
  ts: number = Date.now(),
): MappedSource | MappingError {
  if (ref.file_size !== undefined && ref.file_size > maxBytes) return { error: "tooLarge" };
  switch (kind) {
    case "photo":
      return { filename: `photo-${ts}.jpg`, contentType: "image/jpeg" };
    case "voice":
      return { filename: `voice-${ts}.ogg`, contentType: "audio/ogg" };
    case "document": {
      if (!ref.file_name) return { error: "unsupportedType" };
      let safe: string;
      try {
        safe = safeName(ref.file_name);
      } catch {
        return { error: "unsupportedType" };
      }
      const ext = extOf(safe);
      if (!ext || !(ALLOWED_SOURCE_EXTENSIONS as readonly string[]).includes(ext)) {
        return { error: "unsupportedType" };
      }
      return { filename: safe, contentType: ref.mime_type || EXT_MIME[ext] || "application/octet-stream" };
    }
    case "audio":
    case "video": {
      let name = ref.file_name;
      if (!name) {
        const fromMime = ref.mime_type ? MIME_EXT[ref.mime_type] : undefined;
        if (!fromMime || !(ALLOWED_SOURCE_EXTENSIONS as readonly string[]).includes(fromMime)) {
          return { error: "unsupportedType" };
        }
        name = `${kind}-${ts}.${fromMime}`;
      }
      let safe: string;
      try {
        safe = safeName(name);
      } catch {
        return { error: "unsupportedType" };
      }
      const ext = extOf(safe);
      if (!ext || !(ALLOWED_SOURCE_EXTENSIONS as readonly string[]).includes(ext)) {
        return { error: "unsupportedType" };
      }
      return { filename: safe, contentType: ref.mime_type || EXT_MIME[ext] || "application/octet-stream" };
    }
  }
}

/** Pick the largest PhotoSize (by file_size, falling back to width*height). */
export function pickLargestPhoto(photo: BalePhotoSize[]): BalePhotoSize {
  if (photo.length === 0) throw new Error("pickLargestPhoto: no photos");
  const area = (p: BalePhotoSize): number => p.file_size ?? (p.width ?? 0) * (p.height ?? 0);
  let best = photo[0]!;
  for (const p of photo) if (area(p) > area(best)) best = p;
  return best;
}
