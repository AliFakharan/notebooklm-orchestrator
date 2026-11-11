/**
 * Feature-detected optional dependency: `undici` (EnvHttpProxyAgent for
 * HTTPS_PROXY support) is NOT a hard dependency of this package. This ambient
 * declaration lets the dynamic import type-check on hosts without it; the
 * runtime code falls back to the default direct fetch when the module is
 * absent.
 */
declare module "undici" {
  export class EnvHttpProxyAgent {
    constructor(options?: Record<string, unknown>);
  }
}
