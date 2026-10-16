import type { JobRunner } from "./job-runner.js";

/**
 * In-process durable queue.
 *
 * - At most one job runs at a time (single worker), which is the safe default
 *   for a single local user and avoids concurrent operations against one
 *   account (unverified provider behavior).
 * - Jobs are persisted in SQLite; the worker simply polls for QUEUED jobs.
 * - On application restart, recoverInFlight() (called at boot) resets any
 *   in-flight jobs to QUEUED, so nothing is lost.
 * - Graceful shutdown: stop() finishes the in-flight job (or aborts it) and
 *   stops the poller.
 */
export class Queue {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private stopping = false;
  private current: Promise<unknown> | null = null;

  constructor(
    private readonly runner: JobRunner,
    private readonly pollMs = 500,
    private readonly log: (msg: string) => void,
  ) {}

  start(): void {
    if (this.timer) return;
    this.stopping = false;
    this.timer = setInterval(() => void this.tick(), this.pollMs);
    this.timer.unref?.();
    void this.tick();
  }

  private async tick(): Promise<void> {
    if (this.busy || this.stopping) return;
    const ids = this.runner.queuedIds();
    const id = ids[0];
    if (!id) return;
    if (this.runner.isActive(id)) return;

    this.busy = true;
    this.log(`queue: starting job ${id}`);
    try {
      this.current = this.runner.run(id);
      await this.current;
    } catch (err) {
      this.log(`queue: job ${id} raised: ${String(err)}`);
    } finally {
      this.busy = false;
      this.current = null;
    }
  }

  /** Wait for the in-flight job to finish (used in tests/shutdown). */
  async drain(): Promise<void> {
    if (this.current) await this.current.catch(() => {});
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.drain();
  }

  /** Abort the currently running job (user cancel). */
  cancelCurrent(jobId: string): boolean {
    return this.runner.cancel(jobId);
  }
}
