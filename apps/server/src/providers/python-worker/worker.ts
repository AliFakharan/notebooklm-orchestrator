import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WorkerInbound, isResponse, type WorkerOp, type WorkerResponseT } from "./protocol.js";

export class WorkerError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly ambiguous = false,
  ) {
    super(message);
    this.name = "WorkerError";
  }
}

export interface WorkerOptions {
  /** Python interpreter (default "python3"). Must be able to import notebooklm. */
  pythonBin?: string;
  /** Path to nbl_worker.py (defaults to the one shipped next to this file). */
  workerPath?: string;
  /** Extra env for the child (proxy vars, etc.). */
  env?: Record<string, string>;
  /** Per-request timeout in ms (default 30 min — long jobs). */
  requestTimeoutMs?: number;
  /** Startup (ping) timeout in ms. */
  startupTimeoutMs?: number;
  /** Max stderr captured (bytes) before we stop buffering (still drained). */
  maxStderrBytes?: number;
  log?: (line: string) => void;
}

interface Pending {
  resolve: (r: WorkerResponseT) => void;
  reject: (e: WorkerError) => void;
  timer: NodeJS.Timeout;
}

/**
 * WorkerSupervisor: spawns one Python worker per owner (per account session is
 * NOT required — one worker can serve many requests sequentially) and
 * exchanges JSON-line requests/responses over stdio.
 *
 * Safety properties:
 *  - spawned with an argument array, NEVER a shell string
 *  - stdin/stdout line-buffered; stdout lines length-capped
 *  - stderr drained (never left to deadlock) with a capture cap
 *  - per-request deadline; on timeout the whole process group is killed
 *  - SIGTERM then SIGKILL escalation
 *  - clean shutdown on close()
 */
export class WorkerSupervisor {
  private child: ChildProcessWithoutNullStreams | null = null;
  private nextId = 1;
  private pending = new Map<number, Pending>();
  private stderrTail = "";
  private stderrBytes = 0;
  private stdoutBuf = "";
  private closing = false;
  private exitCode: number | null = null;
  private exitReason: "exited" | "killed" | "closed" = "closed";

  readonly opts: Required<WorkerOptions>;
  readonly workerPath: string;

  constructor(opts: WorkerOptions = {}) {
    this.opts = {
      pythonBin: opts.pythonBin ?? "python3",
      workerPath:
        opts.workerPath ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "nbl_worker.py"),
      env: opts.env ?? {},
      requestTimeoutMs: opts.requestTimeoutMs ?? 30 * 60_000,
      startupTimeoutMs: opts.startupTimeoutMs ?? 20_000,
      maxStderrBytes: opts.maxStderrBytes ?? 64 * 1024,
      log: opts.log ?? (() => {}),
    };
    this.workerPath = this.opts.workerPath;
  }

  private log(line: string): void {
    this.opts.log(line);
  }

  get running(): boolean {
    return this.child !== null && this.exitCode === null;
  }

  /** Spawn the worker and verify with a ping. */
  async start(): Promise<{ version: string | null; playwright: boolean | null }> {
    if (this.running) return this.ping();
    if (!existsSync(this.workerPath)) {
      throw new WorkerError(`worker script not found: ${this.workerPath}`, "configuration");
    }
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Keep the worker quiet unless the app wants worker logs.
      PYTHONUNBUFFERED: "1",
      ...this.opts.env,
    };
    // Never inherit a CWD-based PYTHONPATH; the worker relies on installed pkg.
    delete env.PYTHONSTARTUP;
    const child = spawn(this.opts.pythonBin, [this.workerPath], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      detached: process.platform !== "win32",
    });
    this.child = child;
    this.log(`worker spawned pid=${child.pid} python=${this.opts.pythonBin}`);

    child.stdout.on("data", (chunk: Buffer) => this.onStdout(chunk));
    child.stderr.on("data", (chunk: Buffer) => this.onStderr(chunk));
    child.on("error", (err) => {
      this.log(`worker spawn error: ${err.message}`);
      this.failAll(new WorkerError(`worker spawn error: ${err.message}`, "provider_unavailable"));
    });
    child.on("exit", (code, signal) => {
      this.exitCode = code;
      this.exitReason = signal ? "killed" : "exited";
      this.log(`worker exited code=${code} signal=${signal ?? "none"} stderrTail=${this.tail()}`);
      const err = new WorkerError(
        `python worker exited unexpectedly (code=${code}, signal=${signal ?? "none"}); stderr: ${this.tail()}`,
        "provider_unavailable",
      );
      this.failAll(err);
    });
    child.on("close", () => {
      this.child = null;
      this.exitCode = null;
    });

    // Startup check with a short deadline.
    return await this.request("ping", {}, { timeoutMs: this.opts.startupTimeoutMs }).then((r) => ({
      version: (r.version as string | undefined) ?? null,
      playwright: (r.playwright as boolean | undefined) ?? null,
    }));
  }

  async ping(): Promise<{ version: string | null; playwright: boolean | null }> {
    const r = await this.request("ping", {}, { timeoutMs: this.opts.startupTimeoutMs });
    return {
      version: (r.version as string | undefined) ?? null,
      playwright: (r.playwright as boolean | undefined) ?? null,
    };
  }

  /**
   * Issue one request. `signal` allows external cancellation (job cancel).
   */
  request<T = Record<string, unknown>>(
    op: WorkerOp,
    params: Record<string, unknown>,
    opts: {
      timeoutMs?: number;
      signal?: AbortSignal;
    } = {},
  ): Promise<T> {
    if (!this.running) {
      throw new WorkerError("python worker is not running", "provider_unavailable");
    }
    const child = this.child!;
    const id = this.nextId++;
    const timeoutMs = opts.timeoutMs ?? this.opts.requestTimeoutMs;
    const line = JSON.stringify({ id, op, params }) + "\n";

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.log(`worker request ${id} (${op}) timed out after ${timeoutMs}ms`);
        this.kill(
          new WorkerError(
            `python worker request timed out after ${Math.round(timeoutMs / 1000)}s (op=${op})`,
            "timeout",
            true,
          ),
        );
      }, timeoutMs);

      const onAbort = () => {
        if (!this.pending.has(id)) return;
        this.pending.delete(id);
        clearTimeout(timer);
        this.kill(new WorkerError(`python worker request cancelled (op=${op})`, "timeout"));
      };
      opts.signal?.addEventListener("abort", onAbort, { once: true });

      this.pending.set(id, {
        resolve: (r) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          resolve((r.result ?? {}) as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
          reject(e);
        },
        timer,
      });

      try {
        child.stdin.write(line, (err) => {
          if (err) {
            this.pending.delete(id);
            clearTimeout(timer);
            reject(
              new WorkerError(`worker stdin write failed: ${err.message}`, "provider_unavailable"),
            );
          }
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(
          new WorkerError(`worker stdin write failed: ${String(err)}`, "provider_unavailable"),
        );
      }
    });
  }

  /** Forward worker events (progress/log) to the caller while a request runs. */
  setEventSink(sink: (data: Record<string, unknown>) => void): void {
    (this as { __sink?: (d: Record<string, unknown>) => void }).__sink = sink;
  }

  private emitEvent(data: Record<string, unknown>): void {
    const sink = (this as { __sink?: (d: Record<string, unknown>) => void }).__sink;
    sink?.(data);
  }

  private onStdout(chunk: Buffer): void {
    this.stdoutBuf += chunk.toString("utf8");
    // Cap the unprocessed buffer against pathological output.
    if (this.stdoutBuf.length > 8 * 1024 * 1024) {
      this.log("worker stdout buffer exceeded 8MB — killing");
      this.kill(new WorkerError("worker stdout exceeded size limit", "provider"));
      return;
    }
    let idx: number;
    while ((idx = this.stdoutBuf.indexOf("\n")) >= 0) {
      const line = this.stdoutBuf.slice(0, idx).trim();
      this.stdoutBuf = this.stdoutBuf.slice(idx + 1);
      if (!line) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        this.log(`worker emitted non-JSON line (dropped): ${line.slice(0, 200)}`);
        continue;
      }
      const msg = WorkerInbound.safeParse(parsed);
      if (!msg.success) {
        this.log(`worker emitted invalid message (dropped): ${line.slice(0, 200)}`);
        continue;
      }
      if (isResponse(msg.data)) {
        const pending = this.pending.get(msg.data.id);
        if (!pending) continue; // stale
        this.pending.delete(msg.data.id);
        if (msg.data.ok) {
          pending.resolve(msg.data);
        } else {
          const code = msg.data.error?.code ?? "unknown";
          pending.reject(
            new WorkerError(msg.data.error?.message ?? "worker error", code, code === "ambiguous"),
          );
        }
      } else {
        this.emitEvent(msg.data.data ?? {});
      }
    }
  }

  private onStderr(chunk: Buffer): void {
    const s = chunk.toString("utf8");
    if (this.stderrBytes < this.opts.maxStderrBytes) {
      this.stderrTail += s;
      this.stderrBytes += s.length;
      if (this.stderrTail.length > this.opts.maxStderrBytes) {
        this.stderrTail = this.stderrTail.slice(-this.opts.maxStderrBytes);
      }
    }
    // Always drain (even after cap) to avoid pipe backpressure deadlock.
    this.log(`worker stderr: ${s.trim().slice(0, 300)}`);
  }

  private tail(): string {
    return this.stderrTail.slice(-2000).replace(/\s+/g, " ").trim();
  }

  private failAll(err: WorkerError): void {
    for (const [id, p] of this.pending) {
      this.pending.delete(id);
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  private kill(err: WorkerError): void {
    const child = this.child;
    this.failAll(err);
    if (!child || child.pid === undefined) return;
    const pid = child.pid;
    const escalate = setTimeout(() => {
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        /* already gone */
      }
    }, 5000);
    try {
      if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      clearTimeout(escalate);
    }
  }

  /** Graceful shutdown: SIGTERM, wait, SIGKILL, drain. */
  async close(): Promise<void> {
    if (this.closing) return;
    this.closing = true;
    const child = this.child;
    if (!child || child.pid === undefined) {
      this.failAll(new WorkerError("python worker is not running", "provider_unavailable"));
      return;
    }
    const pid = child.pid;
    await new Promise<void>((resolve) => {
      const t = setTimeout(() => {
        try {
          if (process.platform !== "win32") process.kill(-pid, "SIGKILL");
          else child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
        resolve();
      }, 5000);
      child.once("close", () => {
        clearTimeout(t);
        resolve();
      });
      try {
        if (process.platform !== "win32") process.kill(-pid, "SIGTERM");
        else child.kill("SIGTERM");
      } catch {
        clearTimeout(t);
        resolve();
      }
    });
    this.child = null;
    this.pending.clear();
  }
}
