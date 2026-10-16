import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { redactSecrets } from "@nlo/shared";
import { loadConfig } from "./config.js";
import { createAppContext } from "./app-context.js";
import { buildApp } from "./api/server.js";

/**
 * Server entry point (run with tsx; see package.json scripts).
 *
 * - Binds to config.host (default 127.0.0.1 — loopback only).
 * - Serves the built web app from apps/web/dist if it exists (Phase 3).
 * - Graceful shutdown: stop the queue (drain in-flight job), close app+db.
 */
async function main(): Promise<void> {
  const config = loadConfig();
  const ctx = createAppContext(config);
  const app = await buildApp(ctx);

  // Serve the built frontend (if present) with an SPA fallback. Non-API 404s
  // fall back to index.html; API 404s keep the JSON envelope from buildApp.
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = path.resolve(here, "..", "..", "web", "dist");
  if (existsSync(path.join(webDist, "index.html"))) {
    const { default: fastifyStatic } = await import("@fastify/static");
    await app.register(fastifyStatic, { root: webDist });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === "GET" && !req.url.startsWith("/api")) {
        return reply.type("text/html; charset=utf-8").sendFile("index.html");
      }
      return reply.code(404).send({ error: { code: "not_found", message: "not found" } });
    });
    console.log(`[nlo] serving web UI from ${webDist}`);
  } else {
    console.log("[nlo] web UI not built yet (apps/web/dist missing) — API only");
  }

  const address = await app.listen({ port: config.port, host: config.host });
  console.log(`[nlo] listening on ${address}`);
  console.log(
    `[nlo] provider=${config.provider} proxyRuntime=${config.proxyRuntime} ` +
      `adminAuth=${config.adminToken ? "on" : "off"} liveTests=${config.liveTestsEnabled}`,
  );
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
