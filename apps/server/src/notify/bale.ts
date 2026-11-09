/**
 * BaleNotifier: push alerts to the user's private chat via the Bale bot API
 * (tapi.bale.ai — Telegram-Bot-API-compatible).
 *
 * Why Bale (not Telegram): the server runs in Iran where the Telegram API is
 * blocked; Bale is a domestic service reachable without the egress tunnel.
 *
 * Safety:
 *  - disabled (no token/chat id) -> send() is a no-op with one debug log
 *  - NEVER throws into the caller (the session keeper must not die on a
 *    notification failure)
 *  - the bot token is NEVER logged
 */

const BALE_API_BASE = "https://tapi.bale.ai";
const SEND_TIMEOUT_MS = 10_000;

export interface BaleNotifierDeps {
  botToken: string | null;
  chatId: string | null;
  log?: (msg: string) => void;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

/** Persian message templates. `email` is the verified account identity. */
export const baleMessages = {
  expiry: (email: string) =>
    `⚠️ نشست گوگل اکانت ${email} منقضی شده. لطفاً دوباره وارد شوید و کوکی‌ها را در اپلیکیشن paste کنید.`,
  recovery: (email: string) => `✅ اکانت ${email} دوباره فعال شد.`,
  infra: (email: string) => `⚠️ امکان بررسی اکانت ${email} نیست (مشکل تونل/وورکر).`,
} as const;

export class BaleNotifier {
  private readonly token: string | null;
  private readonly chatId: string | null;
  private readonly log: (msg: string) => void;
  private readonly fetchImpl: typeof fetch;

  constructor(deps: BaleNotifierDeps) {
    this.token = deps.botToken && deps.botToken.trim() ? deps.botToken.trim() : null;
    this.chatId = deps.chatId && deps.chatId.trim() ? deps.chatId.trim() : null;
    this.log = deps.log ?? (() => {});
    this.fetchImpl = deps.fetchImpl ?? fetch;
  }

  /** True when both token and chat id are configured. */
  get enabled(): boolean {
    return this.token !== null && this.chatId !== null;
  }

  /**
   * Send a plain-text message. Resolves in ALL cases (success, disabled,
   * network failure) — it never rejects. The token is never logged.
   */
  async send(text: string): Promise<void> {
    if (!this.enabled) {
      this.log(
        "bale notifier disabled (set NLO_BALE_BOT_TOKEN + NLO_BALE_CHAT_ID to enable); message dropped",
      );
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), SEND_TIMEOUT_MS);
    try {
      const res = await this.fetchImpl(`${BALE_API_BASE}/bot${this.token}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: this.chatId, text }),
        signal: controller.signal,
      });
      if (!res.ok) {
        this.log(`bale send failed: HTTP ${res.status}`);
        return;
      }
      // Drain the body so the socket can be released; we do not surface it.
      await res.text().catch(() => {});
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      this.log(`bale send failed: ${msg}`);
    } finally {
      clearTimeout(timer);
    }
  }
}
