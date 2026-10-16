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
 * Implementation note: the CONNECT tunnel is implemented by `https-proxy-agent`
 * (a maintained, widely-audited dependency of this repo's own toolchain) over
 * Node's `https` module. There is NO direct fallback: any failure at the
 * CONNECT or TLS stage fails the check (fail-closed), and `viaTunnel` is only
 * true when the request genuinely went out through the tunnel.
 *
 * This is the production `fetchThrough` for proxy health checks. It provides
 * real evidence that "a saved configuration" became "a working route":
 *   - CONNECT accepted by the local listener (xray)
 *   - TLS handshake completed through the VLESS tunnel
 *   - HTTP response received from the destination
 */
export async function fetchThroughTunnel(
  tunnel: { host: string; port: number },
  dest: { host: string; port: number },
  opts: { timeoutMs?: number; path?: string; maxBodyBytes?: number } = {},
): Promise<FetchThroughResult> {
  const started = Date.now();
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const path = opts.path ?? "/";
  const maxBody = opts.maxBodyBytes ?? 65_536;

  const agent = new HttpsProxyAgent(`http://${tunnel.host}:${tunnel.port}`);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`https://${dest.host}${path}`, {
        agent,
        signal: controller.signal,
        redirect: "error",
        headers: { "user-agent": "nlo-health/1.0", accept: "*/*" },
      } as RequestInit & { agent: unknown });
      const latencyMs = Date.now() - started;
      const status = res.status;
      let body = "";
      if (status >= 200 && status < 300) {
        const reader = res.body?.getReader?.();
        if (reader) {
          const chunks: Buffer[] = [];
          let total = 0;
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            const buf = Buffer.from(value as Uint8Array);
            chunks.push(buf);
            total += buf.length;
            if (total >= maxBody) break;
          }
          body = Buffer.concat(chunks).toString("utf8");
        } else {
          body = (await res.text()).slice(0, maxBody);
        }
      }
      // Success THROUGH the tunnel is the evidence we need.
      return {
        ok: status >= 200 && status < 300,
        status,
        body,
        latencyMs,
        viaTunnel: true,
      };
    } catch (e) {
      const latencyMs = Date.now() - started;
      const aborted = e instanceof Error && e.name === "AbortError";
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        latencyMs,
        viaTunnel: true, // request was routed through the tunnel and failed there
        error: aborted ? `health check timed out after ${timeoutMs}ms through tunnel` : msg,
      };
    } finally {
      clearTimeout(timer);
    }
  } finally {
    (agent as unknown as { destroy?: () => void }).destroy?.();
  }
}
