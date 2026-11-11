/**
 * Proxy-aware fetch for the bot.
 *
 * When HTTPS_PROXY/https_proxy is set, route requests through undici's
 * EnvHttpProxyAgent. Feature-detected: the agent is only used when the
 * `undici` module is resolvable (npm package, or a Node build that exposes
 * it — Node 22.12+); otherwise we fall back to the default direct fetch.
 *
 * Bale is reachable directly from Iran; proxy support exists for server
 * deployments behind restricted egress.
 */
export async function makeFetch(): Promise<typeof fetch> {
  const proxyEnv = process.env.HTTPS_PROXY ?? process.env.https_proxy;
  if (!proxyEnv) return fetch;
  try {
    const undici = (await import("undici")) as {
      EnvHttpProxyAgent?: new (options?: Record<string, unknown>) => unknown;
    };
    const Agent = undici.EnvHttpProxyAgent;
    if (!Agent) return fetch;
    const dispatcher = new Agent({});
    return ((input: RequestInfo | URL, init?: RequestInit) =>
      fetch(input, { ...init, dispatcher } as unknown as RequestInit)) as typeof fetch;
  } catch {
    return fetch;
  }
}
