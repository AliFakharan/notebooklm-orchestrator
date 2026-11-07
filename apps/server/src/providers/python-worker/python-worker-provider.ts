import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { FailureClass } from "@nlo/shared";
import {
  CapLevel,
  ProviderFailure,
  capabilityMatrix,
  type NotebookLMProvider,
  type ProviderAccountStatus,
  type ProviderJobRequest,
  type ProviderJobResult,
} from "../types.js";
import { WorkerError, WorkerSupervisor } from "./worker.js";
import { isAmbiguousCode } from "./protocol.js";

/**
 * PythonWorkerProvider: REAL NotebookLM access via notebooklm-py running in a
 * short-lived Python worker (JSON-line protocol over stdio).
 *
 * Honesty:
 *  - name is "python-worker" and it is never reported as mock.
 *  - A job without an approved tunnel FAILS (fail-closed) — there is no
 *    direct-egress fallback in the job path.
 *  - Capability levels below are live-untested until the live E2E passes.
 *
 * Session model:
 *  - Each account owns ONE storage-state file under `sessionDir` (0600):
 *        sessionDir/nlo-<accountId>.json
 *  - The file is produced by pasted-cookie import (the user signs into
 *    NotebookLM in their own browser and copies the session cookies into
 *    the UI; the server parses them into a storage state). It is NEVER
 *    served over HTTP.
 *  - credentialRef format: "session:<accountId>".
 */
/** Minimal structural view of a proxy selection (avoids a hard dependency
 *  on the proxy layer; ProxyManager.select satisfies this). */
interface AuthTunnelSelection {
  node: { id: string; config: { name: string } };
  handle: { host: string; port: number };
}

export class PythonWorkerProvider implements NotebookLMProvider {
  readonly name = "python-worker";

  /**
   * Cached config-validation result. Validating spawns a real worker process
   * (cold python start + `import notebooklm-py`, ~5s) — and the environment
   * (python bin, worker path, installed packages) is static for the server's
   * lifetime. So we validate ONCE, in the background at construction, and
   * reuse it. Failures get a short retry TTL so a half-broken environment
   * self-heals; successes are cached until the process exits.
   */
  private validationCache: { ok: boolean; issues: string[]; at: number } | null = null;
  private validationInFlight: Promise<{ ok: boolean; issues: string[] }> | null = null;
  private static readonly FAILURE_RETRY_MS = 15_000;

  constructor(
    private readonly opts: {
      sessionDir: string;
      dataDir: string;
      pythonBin?: string;
      workerPath?: string;
      /** Per-job hard timeout (default 30 min). */
      jobTimeoutMs?: number;
      /**
       * True to allow auth ops (login/verify) WITHOUT a tunnel when NO proxy
       * node is configured at all. Jobs are ALWAYS fail-closed regardless.
       */
      allowDirect?: boolean;
      /** Selects/starts a tunnel for auth ops (login/verify) — fail-closed.
       *  selectAuto self-heals stale health checks (runs the real staged
       *  check against the NotebookLM target) before failing. */
      proxyManager?: {
        selectAuto: (preferredNodeId: string | null) => Promise<AuthTunnelSelection>;
      };
      /** Configured nodes (direct auth only when none exist). */
      proxiesRepo?: {
        countEnabled: () => number;
        listEnabled: () => { id: string }[];
        health: (nodeId: string) => { lastCheckedAt: string | null } | null;
      };
      log?: (line: string) => void;
    },
  ) {
    mkdirSync(this.opts.sessionDir, { recursive: true, mode: 0o700 });
    // Warm the validation cache in the background so the first (and every
    // later) /api/provider call is instant instead of paying the ~5s worker
    // cold-start on the request path.
    void this.validateConfiguration().catch(() => {});
  }

  get log() {
    return this.opts.log ?? (() => {});
  }

  sessionPathFor(accountId: string): string {
    return path.join(this.opts.sessionDir, `nlo-${accountId}.json`);
  }

  private resolveCredential(credentialRef: string, accountId: string): string {
    if (credentialRef === "session" || credentialRef === `session:${accountId}`) {
      return this.sessionPathFor(accountId);
    }
    // Explicit path refs must stay inside the session dir (no traversal).
    const p = path.resolve(credentialRef);
    const dir = path.resolve(this.opts.sessionDir);
    if (!p.startsWith(dir + path.sep)) {
      throw new ProviderFailure({
        failureClass: "provider",
        message: `credentialRef outside session dir: ${credentialRef}`,
        needsReauth: false,
        ambiguous: false,
      });
    }
    return p;
  }

  /** Strict mapping worker error code -> app FailureClass. */
  private toFailureClass(code: string): FailureClass {
    switch (code) {
      case "auth":
        return "auth";
      case "rate_limit":
        return "rate_limit";
      case "connectivity":
        return "connectivity";
      case "invalid_input":
        return "invalid_input";
      case "ambiguous":
        return "ambiguous";
      case "timeout":
      case "provider":
      case "provider_unavailable":
      case "configuration":
        return "provider";
      default:
        return "unknown";
    }
  }

  /**
   * Auth ops (login/verify) must reach the real service. When any proxy node
   * is configured, a tunnel is REQUIRED (same fail-closed policy as jobs):
   * select() validates config + fresh health and starts the tunnel. Only when
   * NO node exists at all does direct egress proceed (an explicit, logged
   * configuration choice).
   */
  private async acquireAuthTunnel(): Promise<{
    nodeId: string;
    handle: { host: string; port: number } | null;
  }> {
    const pm = this.opts.proxyManager;
    const repo = this.opts.proxiesRepo;
    const enabled = repo?.listEnabled() ?? [];
    if (!pm || enabled.length === 0) {
      if (!this.opts.allowDirect) {
        throw new ProviderFailure({
          failureClass: "proxy",
          message:
            "no proxy route available for auth (fail-closed): configure a proxy node or set NLO_ALLOW_DIRECT_EGRESS=1",
          ambiguous: false,
          needsReauth: false,
        });
      }
      this.log(
        "auth op proceeding with DIRECT egress (no proxy node configured; NLO_ALLOW_DIRECT_EGRESS=1)",
      );
      return { nodeId: "", handle: null };
    }
    // selectAuto self-heals stale health (10-min TTL passed) by running the
    // real staged check against the NotebookLM target before failing — the
    // server keeps the user from doing anything, and there is never a
    // direct-egress fallback.
    const sel = await pm.selectAuto(null);
    this.log(
      `auth op routed through node ${sel.node.config.name} (tunnel ${sel.handle.host}:${sel.handle.port})`,
    );
    return {
      nodeId: sel.node.id,
      handle: { host: sel.handle.host, port: sel.handle.port },
    };
  }

  /** Env for a job's worker so notebooklm-py routes through the tunnel. */
  private tunnelEnv(tunnel: { host: string; port: number }): Record<string, string> {
    const proxy = `http://${tunnel.host}:${tunnel.port}`;
    return {
      HTTP_PROXY: proxy,
      HTTPS_PROXY: proxy,
      ALL_PROXY: proxy,
      http_proxy: proxy,
      https_proxy: proxy,
      all_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
    };
  }

  capabilities() {
    const live = CapLevel.implementedUntestedLive;
    return capabilityMatrix({
      validateConfiguration: {
        level: CapLevel.implementedTested,
        note: "worker ping + import check",
      },
      getAccountStatus: { level: live, note: "verify against real service" },
      submitAudioJob: { level: live, note: "real upload + ask via notebooklm-py" },
      retrieveResult: { level: live, note: "real grounded answer" },
      retrieveArtifacts: {
        level: CapLevel.unsupported,
        note: "chat answers are text; no downloadable artifacts in this workflow",
      },
      cancelJob: {
        level: CapLevel.experimental,
        note: "kills the worker; in-flight server op may still finish",
      },
    });
  }

  async validateConfiguration(): Promise<{ ok: boolean; issues: string[] }> {
    const c = this.validationCache;
    if (c) {
      const fresh = c.ok || Date.now() - c.at < PythonWorkerProvider.FAILURE_RETRY_MS;
      if (fresh) return { ok: c.ok, issues: c.issues };
    }
    if (!this.validationInFlight) {
      this.validationInFlight = this.runValidation().then((res) => {
        this.validationCache = { ok: res.ok, issues: res.issues, at: Date.now() };
        this.validationInFlight = null;
        return res;
      });
    }
    return this.validationInFlight;
  }

  /**
   * Actual one-shot validation: spawn a throwaway worker, confirm notebooklm-py
   * is importable, then close it. Never throws (failures are returned as
   * `{ ok:false, issues }`).
   */
  private async runValidation(): Promise<{ ok: boolean; issues: string[] }> {
    try {
      const w = new WorkerSupervisor({
        pythonBin: this.opts.pythonBin,
        workerPath: this.opts.workerPath,
        startupTimeoutMs: 30_000,
        log: this.log,
      });
      try {
        const info = await w.start();
        const issues: string[] = [];
        if (!info.version) issues.push("notebooklm-py package not importable in worker python");
        // NOTE: playwright is NOT required — accounts authenticate via pasted
        // cookies, and no app code launches a browser.
        return { ok: issues.length === 0, issues };
      } finally {
        await w.close().catch(() => {});
      }
    } catch (e) {
      return {
        ok: false,
        issues: [`worker start failed: ${e instanceof Error ? e.message : String(e)}`],
      };
    }
  }

  async getAccountStatus(accountId: string, credentialRef: string): Promise<ProviderAccountStatus> {
    const sessionPath = this.resolveCredential(credentialRef, accountId);
    if (!existsSync(sessionPath)) {
      return {
        ok: false,
        email: null,
        detail: "no session stored for this account (login required)",
      };
    }
    // Verification talks to the REAL service: route through a verified tunnel
    // (fail-closed when nodes exist). The tunnel is kept alive while used.
    const tunnel = await this.acquireAuthTunnel();
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: tunnel.handle ? this.tunnelEnv(tunnel.handle) : {},
      // Through a residential proxy the round-trip to Google can be slow;
      // give verification generous headroom (5 min supervisor / 2 min per
      // inner request) rather than killing a healthy session check.
      requestTimeoutMs: 300_000,
      log: this.log,
    });
    try {
      await w.start();
      const r = await w.request<{ email: string; notebooks: number; checkedAt: string }>("verify", {
        sessionPath,
        timeoutSec: 120,
      });
      return {
        ok: true,
        email: r.email,
        detail: `verified against service (${r.notebooks} notebooks)`,
      };
    } catch (e) {
      const code = e instanceof WorkerError ? e.code : "provider";
      const message = e instanceof Error ? e.message : String(e);
      const cls = this.toFailureClass(code);
      if (cls === "auth") {
        return {
          ok: false,
          email: null,
          detail: `session rejected by service (re-login required): ${message.slice(0, 200)}`,
        };
      }
      throw new ProviderFailure({
        failureClass: cls,
        message,
        ambiguous: isAmbiguousCode(code),
        needsReauth: false, // auth case already returned above
      });
    } finally {
      await w.close();
    }
  }

  async runJob(req: ProviderJobRequest): Promise<ProviderJobResult> {
    if (!req.tunnel && !this.opts.allowDirect) {
      throw new ProviderFailure({
        failureClass: "proxy",
        message:
          "no approved proxy tunnel for this job (fail-closed: direct egress is not allowed)",
        ambiguous: false,
        needsReauth: false,
      });
    }
    const sessionPath = this.resolveCredential(req.credentialRef, req.accountId);
    if (!existsSync(sessionPath)) {
      throw new ProviderFailure({
        failureClass: "auth",
        message: "account has no stored session — complete login first",
        ambiguous: false,
        needsReauth: true,
      });
    }
    const notebookTitle = `nlo-${req.jobId.slice(0, 16)}`;
    const w = new WorkerSupervisor({
      pythonBin: this.opts.pythonBin,
      workerPath: this.opts.workerPath,
      env: req.tunnel ? this.tunnelEnv(req.tunnel) : {},
      requestTimeoutMs: this.opts.jobTimeoutMs ?? 30 * 60_000,
      log: this.log,
    });

    const stageProgress: Record<string, [number, string]> = {
      opening_session: [10, "opening authenticated session"],
      selecting_notebook: [20, "selecting/creating notebook"],
      uploading_sources: [30, "uploading files to NotebookLM"],
      upload_done: [55, "upload complete"],
      waiting_for_processing: [60, "waiting for NotebookLM to process sources"],
      processing_done: [80, "sources processed"],
      executing_prompt: [85, "executing prompt"],
      prompt_done: [95, "prompt completed"],
    };
    w.setEventSink((data) => {
      const stage = typeof data.stage === "string" ? data.stage : "";
      const next = stageProgress[stage];
      if (next) req.onProgress(next[0], next[1]);
    });

    this.active.set(req.jobId, w);
    try {
      await w.start();
      const r = await w.request<{
        email: string;
        notebookId: string | null;
        notebookTitle: string;
        sources: { title: string; sourceId: string | null; reused: boolean }[];
        conversationId: string | null;
        turnNumber: number | null;
        answer: string;
        references: { sourceId: string | null; quote: string | null }[];
        checkedAt: string;
      }>("job", {
        sessionPath,
        sources: req.sources.map((s) => ({
          path: s.path,
          title: s.title,
          mediaType: s.mediaType,
        })),
        prompt: req.prompt,
        notebookTitle,
        waitSec: 1800,
        timeoutSec: Math.floor((this.opts.jobTimeoutMs ?? 30 * 60_000) / 1000),
      });

      if (!r.answer || r.answer.trim().length === 0) {
        throw new ProviderFailure({
          failureClass: "provider",
          message: "provider returned an empty answer; not reporting success",
          ambiguous: true,
          needsReauth: false,
        });
      }
      req.onProgress(100, "retrieved real answer");
      return {
        answerMarkdown: r.answer,
        providerMeta: {
          simulated: false,
          provider: this.name,
          email: r.email,
          notebookId: r.notebookId,
          notebookTitle: r.notebookTitle,
          sources: r.sources,
          conversationId: r.conversationId,
          turnNumber: r.turnNumber,
          references: r.references,
          checkedAt: r.checkedAt,
          route: req.tunnel
            ? { nodeId: req.tunnel.nodeId, host: req.tunnel.host, port: req.tunnel.port }
            : null,
        },
        artifacts: [],
      };
    } catch (e) {
      if (e instanceof ProviderFailure) throw e;
      const code = e instanceof WorkerError ? e.code : "unknown";
      const message = e instanceof Error ? e.message : String(e);
      throw new ProviderFailure({
        failureClass: this.toFailureClass(code),
        message: `python-worker: ${message}`,
        ambiguous: isAmbiguousCode(code),
        needsReauth: code === "auth",
      });
    } finally {
      this.active.delete(req.jobId);
      await w.close();
    }
  }

  /**
   * Cancellation: there is one worker per job; killing it aborts the request.
   * The NOTEBOOKLM-side operation may still finish (documented limit).
   */
  private active = new Map<string, WorkerSupervisor>();
  cancel(jobId: string): Promise<{ accepted: boolean; note: string }> {
    const w = this.active.get(jobId);
    if (!w) {
      return Promise.resolve({
        accepted: false,
        note: "no active worker for this job (already finished or not started)",
      });
    }
    this.active.delete(jobId);
    return w.close().then(() => ({
      accepted: true,
      note: "worker terminated; in-flight NotebookLM operation may still complete server-side",
    }));
  }
}
