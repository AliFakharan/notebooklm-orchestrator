import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "@nlo/shared";
import { loadConfig, loadDotEnv } from "./config.js";
import { createAppContext } from "./app-context.js";
import { buildApp } from "./api/server.js";

/**
 * True when running inside a container (Docker sets /.dockerenv; some runtimes
 * use cgroup markers). Binding to 0.0.0.0 inside a container is normal (the
 * port-forward needs it), so the "no auth on all interfaces" warning is
 * suppressed there.
 */
function inContainer(): boolean {
  try {
    return existsSync("/.dockerenv");
  } catch {
    return false;
  }
}

/**
 * Server entry point (run with tsx; see package.json scripts).
 *
 * - Binds to config.host (default 127.0.0.1 — loopback only).
 * - Serves the built web app from apps/web/dist if it exists (Phase 3).
 * - Graceful shutdown: stop the queue (drain in-flight job), close app+db.
 */
async function main(): Promise<void> {
  loadDotEnv();
  const config = loadConfig();
  const ctx = createAppContext(config);

  // Detect the built frontend first so buildApp can wire the SPA fallback
  // into its (single) root not-found handler. NLO_WEB_DIST overrides the
  // default (mono-repo apps/web/dist) — e.g. containers copy it elsewhere.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = process.env.NLO_WEB_DIST
    ? path.resolve(process.env.NLO_WEB_DIST)
    : path.resolve(here, "..", "..", "web", "dist");
  const hasWebDist = existsSync(path.join(webDist, "index.html"));

  const app = await buildApp(ctx, hasWebDist ? { spaIndexFile: "index.html" } : {});

  if (hasWebDist) {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: webDist });
    console.log(`[nlo] serving web UI from ${webDist}`);
  } else {
    console.log("[nlo] web UI not built yet (apps/web/dist missing) — API only");
  }

  const address = await app.listen({ port: config.port, host: config.host });
  console.log(`[nlo] listening on ${address}`);
  console.log(
    `[nlo] provider=${config.provider} proxyRuntime=${config.proxyRuntime} ` +
      `liveTests=${config.liveTestsEnabled}`,
  );
  if ((config.host === "0.0.0.0" || config.host === "::") && !inContainer()) {
    console.warn(
      `[nlo] WARNING: bound to all interfaces without any auth — do NOT expose this to a network.`,
    );
  }
  if (config.provider === "mock") {
    console.log("[nlo] NOTE: mock provider is active — all job results are simulated.");
  }

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[nlo] ${signal}: shutting down (draining queue)`);
    try {
      await ctx.close();
      await app.close();
    } catch (err) {
      console.error(`[nlo] shutdown error: ${redactSecrets(String(err))}`);
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    console.error(`[nlo] unhandledRejection: ${redactSecrets(String(reason))}`);
  });
}

main().catch((err: unknown) => {
  console.error(`[nlo] fatal startup error: ${redactSecrets(String(err))}`);
  process.exit(1);
});
