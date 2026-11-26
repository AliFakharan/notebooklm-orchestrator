import type { NotebookSessionsRepo } from "../domain/notebook-sessions.repo.js";

/**
 * NotebookSessionSweeper: background idle-TTL reaper for persistent notebook
 * sessions. Every interval it moves `open` sessions whose `last_used_at` is
 * older than `ttlMs` to `expired`. The bot notices the next time a session op
 * fails (the runner fails anchored jobs against a non-open session) and returns
 * the chat to IDLE. Disabling is explicit: `ttlMs <= 0` turns the sweeper off.
 */
export interface NotebookSessionSweeperDeps {
  sessions: NotebookSessionsRepo;
  /** Idle TTL in ms; `<= 0` disables auto-expiry. */
  ttlMs: number;
  /** How often to sweep (ms). */
  intervalMs: number;
  log: (msg: string) => void;
  /** Injectable timer factories (tests). */
  setIntervalFn?: (fn: () => void, ms: number) => NodeJS.Timeout;
  clearIntervalFn?: (h: NodeJS.Timeout) => void;
}

export class NotebookSessionSweeper {
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: NotebookSessionSweeperDeps) {}

  get enabled(): boolean {
    return this.d.ttlMs > 0;
  }

  start(): void {
    if (!this.enabled || this.timer) return;
    const set = this.d.setIntervalFn ?? ((fn, ms) => setInterval(fn, ms));
    this.timer = set(() => {
      try {
        this.sweep();
      } catch (e) {
        this.d.log(`notebook session sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }, this.d.intervalMs);
    this.timer.unref?.();
    this.d.log(
      `notebook session sweeper started (ttl=${this.d.ttlMs}ms, every ${this.d.intervalMs}ms)`,
    );
  }

  stop(): void {
    if (!this.timer) return;
    const clear = this.d.clearIntervalFn ?? ((h) => clearInterval(h));
    clear(this.timer);
    this.timer = null;
  }

  /** Expire open sessions idle longer than the TTL. Returns the expired ids. */
  sweep(): string[] {
    if (!this.enabled) return [];
    const expired = this.d.sessions.expireStale(this.d.ttlMs);
    if (expired.length > 0) {
      this.d.log(`expired ${expired.length} idle notebook session(s): ${expired.join(", ")}`);
    }
    return expired;
  }
}
