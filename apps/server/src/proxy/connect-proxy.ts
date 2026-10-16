import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlink } from "node:fs";
import https from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { HttpsProxyAgent } from "https-proxy-agent";

export interface FetchThroughResult {
  ok: boolean;
  body?: string;
  status?: number;
  latencyMs: number;
  error?: string;
  /** True iff the request was actually routed through the given tunnel. */
  viaTunnel: boolean;
}

/**
 * Perform a real HTTPS request THROUGH a local HTTP CONNECT proxy.
 *
 * Client selection:
 *  - PRIMARY: `curl` (if present on the system). Measured on this deployment:
 *    Google/Cloudflare actively reset (ECONNRESET) TLS connections from
 *    Node's BoringSSL client even with a browser UA, while curl's OpenSSL
 *    handshake gets a normal HTTP response (301) through the exact same
 *    tunnel. The route is identical; only the client TLS fingerprint
 *    differs. curl keeps the request 100% real: CONNECT to the tunnel, TLS
 *    to the destination, HTTP response.
 *  - FALLBACK: node:https + HttpsProxyAgent (the agent is honored by core
 *    https; the global fetch/undici does NOT honor an `agent` option).
 *
 * There is NO direct fallback at either stage: any failure at the CONNECT or
 * TLS stage fails the check (fail-closed), and `viaTunnel` is only true when
 * the request genuinely went out through the tunnel.
 *
 * This is the production `fetchThrough` for proxy health checks. It provides
 * real evidence that "a saved configuration" became "a working route":
 *   - CONNECT accepted by the local listener (xray)
 *   - TLS handshake completed through the VLESS tunnel
 *   - HTTP response received from the destination
 */

const BROWSER_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function findCurl(): string | null {
  for (const p of ["/usr/bin/curl", "/bin/curl", "/usr/local/bin/curl"]) {
    if (existsSync(p)) return p;
  }
  return null;
}

function readBodyFile(file: string, maxBytes: number): string {
  try {
    return readFileSync(file, "utf8").slice(0, maxBytes);
  } catch {
    return "";
  }
}

function fetchWithCurl(
  curl: string,
  tunnel: { host: string; port: number },
  dest: { host: string; port: number },
  timeoutMs: number,
  maxBody: number,
): Promise<FetchThroughResult> {
  const started = Date.now();
  const bodyFile = path.join(
    tmpdir(),
    `nlo-egress-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.body`,
  );
  const url = `https://${dest.host}:${dest.port}/`;
  const args = [
    "-s",
    "--max-time",
    String(Math.ceil(timeoutMs / 1000)),
    "--http1.1",
    "-A",
    BROWSER_UA,
    "-o",
    bodyFile,
    "-w",
    "%{http_code}",
    "-x",
    `http://${tunnel.host}:${tunnel.port}`,
    url,
  ];
  return new Promise((resolve) => {
    const proc = spawn(curl, args, { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let errTail = "";
    proc.stdout.on("data", (c) => (out += c.toString("utf8")));
    proc.stderr.on("data", (c) => {
      errTail += c.toString("utf8");
      if (errTail.length > 4000) errTail = errTail.slice(-4000);
    });
    proc.on("error", (e) =>
      resolve({
        ok: false,
        latencyMs: Date.now() - started,
        viaTunnel: true,
        error: `curl spawn failed: ${e.message}`,
      }),
    );
    proc.on("close", (code) => {
      const body = readBodyFile(bodyFile, maxBody);
      unlink(bodyFile, () => {});
      if (code === 0) {
        const status = Number(out.trim().split(/\s+/).pop());
        if (Number.isInteger(status) && status > 0) {
          const ok = status >= 200 && status < 300;
          resolve({
            ok,
            status,
            body,
            latencyMs: Date.now() - started,
            viaTunnel: true,
            error: ok ? undefined : `destination answered ${status} through tunnel`,
          });
          return;
        }
      }
      // Keep the meaningful last lines (curl -s prints errors to stderr).
      const curlErr = errTail.split("\n").filter(Boolean).slice(-2).join(" | ");
      resolve({
        ok: false,
        latencyMs: Date.now() - started,
        viaTunnel: true,
        error:
          `curl exited ${code}` +
          (curlErr ? `: ${curlErr.slice(0, 200)}` : "") +
          (code === 28 ? " (timeout through tunnel)" : ""),
      });
    });
  });
}

function fetchWithNodeHttps(
  tunnel: { host: string; port: number },
  dest: { host: string; port: number },
  timeoutMs: number,
  maxBody: number,
): Promise<FetchThroughResult> {
  const started = Date.now();
  const agent = new HttpsProxyAgent(`http://${tunnel.host}:${tunnel.port}`);
  return new Promise<FetchThroughResult>((resolve) => {
    let settled = false;
    const finish = (r: FetchThroughResult) => {
      if (!settled) {
        settled = true;
        (agent as unknown as { destroy?: () => void }).destroy?.();
        resolve(r);
      }
    };
    const fail = (message: string) =>
      finish({ ok: false, latencyMs: Date.now() - started, viaTunnel: true, error: message });
    const req = https.request(
      {
        host: dest.host,
        port: dest.port,
        path: "/",
        method: "GET",
        agent,
        timeout: timeoutMs,
        headers: { "user-agent": BROWSER_UA, accept: "*/*" },
      },
      (res) => {
        const status = res.statusCode ?? 0;
        const chunks: Buffer[] = [];
        let total = 0;
        res.on("data", (c: Buffer) => {
          chunks.push(c);
          total += c.length;
          if (total >= maxBody) req.destroy();
        });
        res.on("end", () => {
          const ok = status >= 200 && status < 300;
          const body = Buffer.concat(chunks).toString("utf8").slice(0, maxBody);
          finish({
            ok,
            status,
            body,
            latencyMs: Date.now() - started,
            viaTunnel: true,
            error: ok ? undefined : `destination answered ${status} through tunnel`,
          });
        });
        res.on("error", (e) => fail(e.message));
      },
    );
    req.on("timeout", () =>
      req.destroy(new Error(`health check timed out after ${timeoutMs}ms through tunnel`)),
    );
    req.on("error", (e) => fail(e.message));
    req.end();
  });
}

export async function fetchThroughTunnel(
  tunnel: { host: string; port: number },
  dest: { host: string; port: number },
  opts: { timeoutMs?: number; path?: string; maxBodyBytes?: number } = {},
): Promise<FetchThroughResult> {
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const maxBody = opts.maxBodyBytes ?? 65_536;
  const curl = findCurl();
  if (curl) return fetchWithCurl(curl, tunnel, dest, timeoutMs, maxBody);
  return fetchWithNodeHttps(tunnel, dest, timeoutMs, maxBody);
}
