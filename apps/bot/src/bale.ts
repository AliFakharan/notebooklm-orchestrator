/**
 * Minimal Bale bot API client (tapi.bale.ai — Telegram-Bot-API-compatible).
 *
 * Safety:
 *  - the bot token is NEVER logged
 *  - network/API errors throw BaleApiError; the caller (update loop) keeps
 *    polling after transient failures
 *  - sendMessage never throws (it reports success per chunk)
 */

import { createWriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

const DEFAULT_BASE = "https://tapi.bale.ai";
const LONG_POLL_TIMEOUT_SEC = 30;
const CALL_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;

/** Bale's hard per-message text limit; we keep a small safety margin. */
export const BALE_MESSAGE_HARD_LIMIT = 4096;
export const BALE_MESSAGE_CHUNK_MAX = 4000;

export interface BaleChat {
  id: number;
  type: string;
  first_name?: string;
}

export interface BaleFileRef {
  file_id: string;
  file_name?: string;
  file_size?: number;
  mime_type?: string;
}

export interface BalePhotoSize extends BaleFileRef {
  width?: number;
  height?: number;
}

/** Only the fields the bot uses; the API payload is otherwise opaque. */
export interface BaleMessage {
  message_id?: number;
  chat: BaleChat;
  text?: string;
  caption?: string;
  document?: BaleFileRef;
  photo?: BalePhotoSize[];
  audio?: BaleFileRef;
  voice?: BaleFileRef;
  video?: BaleFileRef;
}

export interface BaleUpdate {
  update_id: number;
  message?: BaleMessage;
}

export interface BaleMe {
  id: number;
  first_name: string;
  username?: string;
}

export class BaleApiError extends Error {
  constructor(
    message: string,
    /** HTTP status; 0 = network failure. 429 → honor retryAfterSec. */
    public readonly status: number,
    public readonly retryAfterSec: number | null = null,
  ) {
    super(message);
    this.name = "BaleApiError";
  }
}

export interface BaleClientDeps {
  token: string;
  apiBase?: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  /** When aborted, in-flight long-polls stop (graceful shutdown). */
  abortSignal?: AbortSignal;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * Split text into chunks of at most `max` chars, preferring newline
 * boundaries (a hard cut is used only inside a single line longer than max).
 * No character is lost or duplicated; newline separators at chunk boundaries
 * are implied by the message break.
 */
export function chunkText(text: string, max = BALE_MESSAGE_CHUNK_MAX): string[] {
  if (!text) return [];
  if (max < 1) throw new Error("chunk max must be >= 1");
  if (text.length <= max) return [text];
  const chunks: string[] = [];
  let cur = "";
  let hasCur = false;
  const flush = (): void => {
    if (hasCur) {
      chunks.push(cur);
      cur = "";
      hasCur = false;
    }
  };
  for (const line of text.split("\n")) {
    if (line.length > max) {
      flush();
      for (let i = 0; i < line.length; i += max) chunks.push(line.slice(i, i + max));
      continue;
    }
    const candidate = hasCur ? cur + "\n" + line : line;
    if (candidate.length <= max) {
      cur = candidate;
      hasCur = true;
    } else {
      flush();
      cur = line;
      hasCur = true;
    }
  }
  flush();
  return chunks;
}

export class BaleClient {
  private readonly token: string;
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly log: (m: string) => void;
  private readonly abortSignal: AbortSignal | undefined;

  constructor(deps: BaleClientDeps) {
    this.token = deps.token;
    this.base = (deps.apiBase ?? DEFAULT_BASE).replace(/\/+$/, "");
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.log = deps.log ?? (() => {});
    this.abortSignal = deps.abortSignal;
  }

  private url(method: string): string {
    return `${this.base}/bot${this.token}/${method}`;
  }

  private async call<T>(method: string, body: unknown, timeoutMs: number): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const onAbort = (): void => controller.abort();
    this.abortSignal?.addEventListener("abort", onAbort, { once: true });
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(method), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      if (this.abortSignal?.aborted) throw new BaleApiError("stopped", 0);
      throw new BaleApiError(
        `bale request failed: ${e instanceof Error ? e.message : String(e)}`,
        0,
      );
    } finally {
      clearTimeout(timer);
      this.abortSignal?.removeEventListener("abort", onAbort);
    }
    let data: {
      ok: boolean;
      result?: T;
      description?: string;
      error_code?: number;
      parameters?: { retry_after?: number };
    };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw new BaleApiError(`bale returned non-JSON (HTTP ${res.status})`, res.status);
    }
    if (!res.ok || !data.ok) {
      throw new BaleApiError(
        data.description ?? `bale error (HTTP ${res.status})`,
        res.status,
        data.parameters?.retry_after ?? null,
      );
    }
    return data.result as T;
  }

  /** Bot identity; null on failure (logged, not thrown). */
  async getMe(): Promise<BaleMe | null> {
    try {
      return await this.call<BaleMe>("getMe", {}, CALL_TIMEOUT_MS);
    } catch (e) {
      this.log(`getMe failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /**
   * Long-poll for new updates. Pass offset = last confirmed update_id + 1.
   * Throws BaleApiError on failure (the caller retries; offset is NOT
   * advanced on error).
   */
  async getUpdates(offset: number, timeoutSec = LONG_POLL_TIMEOUT_SEC): Promise<BaleUpdate[]> {
    return this.call<BaleUpdate[]>("getUpdates", { offset, timeout: timeoutSec }, (timeoutSec + 20) * 1000);
  }

  /**
   * Send text, auto-chunked to Bale's 4096-char limit. Resolves with an
   * overall success flag; never throws. On 429 it honors retry_after once.
   */
  async sendMessage(chatId: number, text: string): Promise<boolean> {
    const chunks = chunkText(text).filter((c) => c.length > 0);
    if (chunks.length === 0) return true;
    let ok = true;
    for (const chunk of chunks) {
      if (!await this.sendChunk(chatId, chunk)) ok = false;
    }
    return ok;
  }

  private async sendChunk(chatId: number, chunk: string): Promise<boolean> {
    const send = (): Promise<void> =>
      this.call<void>("sendMessage", { chat_id: chatId, text: chunk }, CALL_TIMEOUT_MS);
    try {
      await send();
      return true;
    } catch (e) {
      if (e instanceof BaleApiError && e.status === 429 && e.retryAfterSec !== null) {
        await sleep(Math.min(e.retryAfterSec, 30) * 1000);
        try {
          await send();
          return true;
        } catch {
          return false;
        }
      }
      this.log(`sendMessage failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }

  /**
   * Download a file: getFile(file_id) → file_path → GET /file/bot<token>/<path>
   * streamed to destPath. Throws on any failure (caller cleans up / reports).
   */
  async downloadFile(fileId: string, destPath: string): Promise<void> {
    const info = await this.call<{ file_path?: string }>("getFile", { file_id: fileId }, CALL_TIMEOUT_MS);
    const filePath = info?.file_path;
    if (!filePath) throw new BaleApiError("getFile returned no file_path", 0);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/file/bot${this.token}/${filePath}`, {
        signal: controller.signal,
      });
    } catch (e) {
      throw new BaleApiError(`file download failed: ${e instanceof Error ? e.message : String(e)}`, 0);
    } finally {
      clearTimeout(timer);
    }
    if (!res.ok || !res.body) {
      await res.body?.cancel().catch(() => {});
      throw new BaleApiError(`file download failed (HTTP ${res.status})`, res.status);
    }
    try {
      await pipeline(
        Readable.fromWeb(res.body as unknown as import("node:stream/web").ReadableStream),
        createWriteStream(destPath),
      );
    } catch (e) {
      await rm(destPath, { force: true }).catch(() => {});
      throw new BaleApiError(`file download failed: ${e instanceof Error ? e.message : String(e)}`, 0);
    }
  }

  /** Configure /start /help /cancel. Log-only on failure (non-fatal). */
  async setMyCommands(commands: { command: string; description: string }[]): Promise<boolean> {
    try {
      await this.call<void>("setMyCommands", { commands }, CALL_TIMEOUT_MS);
      return true;
    } catch (e) {
      this.log(`setMyCommands failed: ${e instanceof Error ? e.message : String(e)}`);
      return false;
    }
  }
}
